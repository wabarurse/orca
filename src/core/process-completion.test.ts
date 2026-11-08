import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeProcess } from "./process-completion";
import { run } from "./proc";
import { bash } from "./tools/bash/bash";
import { assertLayout, paths } from "../config";
import { launchProcess, readProcess, liveProcess } from "./data/processes";
import { cliCommand } from "./tmux";
import { killGroup } from "./process-signals";
import { pidAlive } from "./data/storage-lock";

let home: string | undefined, previous = process.env.ORCA_HOME;
const escaped = new Set<number>();
afterEach(async () => {
  for (const pid of escaped) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
  escaped.clear();
  if (home) { rmSync(home, { recursive: true, force: true }); home = undefined; }
  if (previous !== undefined) process.env.ORCA_HOME = previous; else delete process.env.ORCA_HOME;
});
function setup() {
  previous = process.env.ORCA_HOME;
  home = mkdtempSync(join(tmpdir(), "orca-pipe-drain-")); process.env.ORCA_HOME = home;
  assertLayout(home); mkdirSync(paths.project("p"), { recursive: true });
  return home;
}
function stuck() {
  return { pid: 987654321, stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from("partial output")); }, cancel() { return new Promise<void>(() => {}); } }),
    exited: new Promise<number>(() => {}), kill() {}, unref() {} };
}

test("kill failures preserve both process-group and parent permission errors", () => {
  const original = process.kill.bind(process);
  const spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -987654321) throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
    return original(pid, signal);
  });
  try {
    const errors = killGroup({ pid: 987654321, kill() { throw Object.assign(new Error("Permission denied"), { code: "EPERM" }); } });
    expect(errors).toEqual(["process group 987654321: EPERM", "process 987654321: EPERM"]);
  } finally { spy.mockRestore(); }
});

test("timeout and cancellation end collection even when signalling is denied and the child never exits", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(); let output = "";
    const timer = cancel ? setTimeout(() => controller.abort(new Error("user cancelled")), 10) : undefined;
    const started = Date.now();
    const result = await completeProcess(stuck(), { timeoutMs: cancel ? 5000 : 10, signal: controller.signal, drainMs: 20,
      kill: () => ["process group 987654321: EPERM"], chunk: bytes => { output += Buffer.from(bytes).toString(); } });
    clearTimeout(timer);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(output).toBe("partial output");
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.code).toBeNull();
    expect(result.cleanupErrors).toContain("process group 987654321: EPERM");
    expect(result.timedOut).toBe(!cancel);
  }
});

test("parent exit does not wait forever for a descendant's inherited pipe", async () => {
  const child = { ...stuck(), exited: Promise.resolve(0) };
  const result = await completeProcess(child, { timeoutMs: 5000, drainMs: 20, kill: () => [], chunk() {} });
  expect(result.code).toBe(0);
  expect(result.reason).toContain("pipes remained open");
  expect(result.cleanupIncomplete).toBe(true);
});

function escapedCommand(pidFile: string) {
  return `const child=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{detached:true,stdout:"inherit",stderr:"inherit"}); await Bun.write(${JSON.stringify(pidFile)},String(child.pid)); console.log("test runner finished"); process.exit(0);`;
}
async function rememberPid(path: string) {
  const pid = Number(await Bun.file(path).text()); escaped.add(pid); return pid;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("internal and foreground commands preserve partial output and fail promptly for a real escaped pipe holder", async () => {
  const cwd = setup();
  for (const foreground of [false, true]) {
    const pidFile = join(cwd, `${foreground}.pid`), script = escapedCommand(pidFile), started = Date.now();
    try {
      if (foreground) {
        let message = "";
        try { await bash.run({ command: `${quote(process.execPath)} -e ${quote(script)}`, timeout_ms: 5000, max_output_bytes: 512 }, { project: "p", role: "orchestrator", cwd }); }
        catch (error) { message = (error as Error).message; }
        expect(message).toContain("test runner finished");
        expect(message).toStartWith("command failed: cleanup incomplete");
        expect(Buffer.byteLength(message)).toBeLessThanOrEqual(512);
        expect(message).toContain("cleanup incomplete");
        expect(message).toContain("partial output:");
        const path = /\[partial output: (.+)\]$/.exec(message)?.[1];
        expect(await Bun.file(path!).text()).toContain("test runner finished");
      } else {
        const result = await run([process.execPath, "-e", script], { cwd, timeoutMs: 5000 });
        expect(result?.code).toBe(-1);
        expect(result?.out).toContain("test runner finished");
        expect(result?.err).toContain("cleanup incomplete");
      }
      expect(Date.now() - started).toBeLessThan(4500);
    } finally { await rememberPid(pidFile); }
  }
}, 15000);

test("background supervisor reports unknown cleanup and emits an event rather than hanging", async () => {
  const cwd = setup(), pidFile = join(cwd, "background.pid"), at = new Date().toISOString(), id = crypto.randomUUID();
  try {
    await launchProcess({ id, project: "p", owner: "worker-test", role: "worker", branch: "test", cwd,
      command: `${quote(process.execPath)} -e ${quote(escapedCommand(pidFile))}`, createdAt: at, updatedAt: at,
      state: "starting", timeoutMs: 5000, maxBytes: 4096, notify: true, events: [] }, cliCommand(), 0);
    const deadline = Date.now() + 8000;
    let record = await readProcess("p", id);
    while (liveProcess(record) && Date.now() < deadline) { await Bun.sleep(25); record = await readProcess("p", id); }
    expect(record.state).toBe("unknown");
    expect(record.reason).toContain("cleanup incomplete");
    expect(record.events.some(event => event.event.state === "unknown")).toBe(true);
    expect(await Bun.file(join(paths.runtimeProject("p"), "processes", id, "output.txt")).text()).toContain("test runner finished");
    while (record.supervisorPid && pidAlive(record.supervisorPid) && Date.now() < deadline) await Bun.sleep(25);
    expect(record.supervisorPid ? pidAlive(record.supervisorPid) : false).toBe(false);
  } finally { await rememberPid(pidFile); }
}, 15000);
