import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const home = mkdtempSync(join(tmpdir(), "parallels-exits-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const { createAgent } = await import("./agent");
const { afterExit, beginRun, claim, noticeText, readRun, supervise, watchdog } = await import("./exits");
const { drain, put } = await import("./inbox");
const { agentCommand } = await import("./runner");
const { message } = await import("./tools/message");
const { fakeProvider, text, toolUse } = await import("./test/fake-provider");
const { open } = await import("./transcript");
const { paths } = await import("./config");

let n = 0;
let project = "";
beforeEach(() => {
  project = `p${n++}`;
});

/** A git worktree-like dir with `dirty` uncommitted files. */
async function repo(dirty: number): Promise<string> {
  const dir = mkdtempSync(join(home, "wt-"));
  await $`git init -q ${dir}`.quiet();
  for (let i = 0; i < dirty; i++) writeFileSync(join(dir, `f${i}`), "x");
  return dir;
}

const info = (cwd: string, run = "r1") => ({ project, id: "worker-feat", run, role: "worker" as const, branch: "feat", cwd });
const quiet = () => {};
const inbox = () => drain(project, "orchestrator");

/** An agent body: a fake model scripted with `script`, tracked by supervise's tracker. */
const agentBody = (cwd: string, script: Parameters<typeof fakeProvider>[0]) => async (tracker: import("./exits").Tracker) => {
  const transcript = open(join(home, `${project}-${crypto.randomUUID()}.jsonl`));
  await transcript.append({ type: "message", message: { role: "user", content: "go" } });
  await createAgent({
    provider: fakeProvider(script),
    transcript,
    tools: { message },
    model: "m",
    ctx: { project, role: "worker", branch: "feat", cwd },
    write: quiet,
    tracker,
  }).run();
};

describe("case 1: the loop throws", () => {
  test("one crash notice with the error, last tool, role, branch and dirty count; exit code 1", async () => {
    const cwd = await repo(2);
    // One tool call, then the script runs out: the provider throws like an API error.
    const code = await supervise(info(cwd), agentBody(cwd, [[toolUse("t1", "message", { to: "user", text: "hi" })]]), quiet);
    expect(code).toBe(1);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("worker-feat");
    const t = msgs[0]!.text;
    expect(t.startsWith("[agent-exit] worker-feat crashed: fake provider: script exhausted")).toBe(true);
    expect(t).toContain("role worker; branch feat; last step: model request; last tool: message");
    expect(t).toContain("uncommitted changes: 2");
  });

  test("the shell follow-up after the crash sends nothing more", async () => {
    const cwd = await repo(0);
    expect(await supervise(info(cwd), async () => { throw new Error("boom"); }, quiet)).toBe(1);
    expect(await afterExit({ ...info(cwd), code: 1 })).toBe(false);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("crashed: boom");
  });
});

describe("case 2: killed or a non-zero exit", () => {
  test("killed mid-run: one notice naming the signal and the last step; a second follow-up sends nothing", async () => {
    const cwd = await repo(1);
    const t = await beginRun(info(cwd));
    await t.step('bash {"command":"bun test"}', true);
    expect(await afterExit({ ...info(cwd), code: 137 })).toBe(true);
    expect(await afterExit({ ...info(cwd), code: 137 })).toBe(false);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toBe(`[agent-exit] worker-feat exited (code 137, signal 9) without reporting (role worker; branch feat; last step: bash {"command":"bun test"}; uncommitted changes: 1)`);
  });

  test("died before the agent wrote its run: still one notice", async () => {
    const cwd = await repo(0);
    await beginRun(info(cwd, "old")); // an earlier run's state
    expect(await afterExit({ ...info(cwd, "new"), code: 1 })).toBe(true);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("exited (code 1) without reporting (role worker; branch feat; last step: before the agent started");
  });

  test("nothing when the run had reported", async () => {
    const cwd = await repo(0);
    const t = await beginRun(info(cwd));
    await t.reported();
    expect(await afterExit({ ...info(cwd), code: 1 })).toBe(false);
    expect(await inbox()).toEqual([]);
  });
});

describe("case 3: clean exit", () => {
  test("without a report: one notice", async () => {
    const cwd = await repo(0);
    expect(await supervise(info(cwd), agentBody(cwd, [[text("done, I think")]]), quiet)).toBe(0);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("[agent-exit] worker-feat finished without reporting (role worker; branch feat; last step: model request; uncommitted changes: 0)");
  });

  test("after reporting to the orchestrator: only the report", async () => {
    const cwd = await repo(0);
    const script = [[toolUse("t1", "message", { to: "orchestrator", text: "done" })], [text("")]];
    expect(await supervise(info(cwd), agentBody(cwd, script), quiet)).toBe(0);
    const msgs = await inbox();
    expect(msgs.map((m) => m.text)).toEqual(["done"]);
    expect((await readRun(project, "worker-feat"))!.state).toBe("reported");
  });

  test("a message to someone else is not a report", async () => {
    const cwd = await repo(0);
    const script = [[toolUse("t1", "message", { to: "user", text: "hi" })], [text("")]];
    await supervise(info(cwd), agentBody(cwd, script), quiet);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("finished without reporting");
  });

  test("new instructions after the report need a new report", async () => {
    const cwd = await repo(0);
    // The orchestrator's note lands while the report is being sent, so it rides along with the result.
    const script = [[toolUse("t1", "message", { to: "orchestrator", text: "done" })], [text("")]];
    const body = agentBody(cwd, script);
    await supervise(info(cwd), async (t) => {
      const reported = t.reported.bind(t);
      t.reported = async () => { await reported(); await put(project, "worker-feat", { from: "orchestrator", text: "one more fix" }); };
      await body(t);
    }, quiet);
    const msgs = await inbox();
    expect(msgs.map((m) => m.text.slice(0, 45))).toEqual(["done", "[agent-exit] worker-feat finished without rep"]);
  });
});

describe("case 4: the watchdog", () => {
  test("fires once for a vanished window whose run neither reported nor sent a notice", async () => {
    const cwd = await repo(0);
    const ids = ["worker-a", "worker-b", "worker-c", "reviewer-a"];
    const runs = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await beginRun({ ...info(cwd), id })] as const)));
    await runs["worker-a"]!.reported(); // reported: no notice
    await runs["worker-b"]!.step('bash {"command":"ls"}', true); // silent: notice
    expect(await claim(project, "worker-c", "r1")).toBe(true); // already sent its own notice
    // reviewer-a stays live.
    let live = ids;
    const check = watchdog(async () => live);
    expect(await check(project)).toEqual([]);
    live = ["reviewer-a"];
    expect(await check(project)).toEqual(["worker-b"]);
    expect(await check(project)).toEqual([]);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("worker-b");
    expect(msgs[0]!.text).toBe(`[agent-exit] worker-b's window is gone (role worker; branch feat; last step: bash {"command":"ls"}; uncommitted changes: unknown)`);
  });

  test("does not fire for agents it never saw live", async () => {
    const cwd = await repo(0);
    await beginRun(info(cwd));
    const check = watchdog(async () => []);
    expect(await check(project)).toEqual([]);
    expect(await check(project)).toEqual([]);
    expect(await inbox()).toEqual([]);
  });
});

test("noticeText keeps the error on one capped line", () => {
  const t = noticeText("worker-x", `crashed: ${"a\n".repeat(500)}`, { role: "worker", branch: "x", step: "s", tool: "s" }, null);
  expect(t).not.toContain("\n");
  expect(t.length).toBeLessThan(800);
});

describe("agentCommand", () => {
  const nasty = `p'; touch pwned; echo "$(id)" \`id\` $HOME`;

  /** Run the window command under sh with a fake `bun` that logs its argv and exits with $FAKE_CODE for `agent`. */
  async function runWith(code: number) {
    const bin = mkdtempSync(join(home, "bin-"));
    const log = join(bin, "log");
    writeFileSync(join(bin, "bun"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'\necho --- >> '${log}'\n[ "$2" = agent ] && exit "$FAKE_CODE"\nexit 0\n`);
    chmodSync(join(bin, "bun"), 0o755);
    const cwd = mkdtempSync(join(home, "cwd-"));
    const cmd = agentCommand({ project: nasty, role: "worker", branch: "feat/x" }, "run1");
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CODE: String(code) } });
    const exit = await proc.exited;
    const calls = readFileSync(log, "utf8").split("---\n").filter(Boolean).map((c) => c.split("\n").filter(Boolean));
    return { exit, calls, cwd };
  }

  test("a clean exit runs only the agent, with every value passed through verbatim", async () => {
    const { exit, calls, cwd } = await runWith(0);
    expect(exit).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.slice(1)).toEqual(["agent", "--project", nasty, "--role", "worker", "--branch", "feat/x", "--run", "run1"]);
    expect(await Bun.file(join(cwd, "pwned")).exists()).toBe(false);
  });

  test("a non-zero exit runs agent-exit with the same run id and the code", async () => {
    const { exit, calls } = await runWith(137);
    expect(exit).toBe(137);
    expect(calls.length).toBe(2);
    expect(calls[1]!.slice(1)).toEqual(["agent-exit", "--project", nasty, "--role", "worker", "--branch", "feat/x", "--run", "run1", "--code", "137"]);
  });

  test("the orchestrator gets no wrapper", () => {
    expect(agentCommand({ project: "p", role: "orchestrator" }, "r")).not.toContain("code=$?");
  });

  test("end to end: a real agent that crashes at start sends exactly one notice", async () => {
    // No transcript seeded, so `parallels agent` throws; the shell follow-up must not add a second notice.
    const cwd = await repo(0);
    mkdirSync(paths.project(project), { recursive: true });
    const proc = Bun.spawn(["sh", "-c", agentCommand({ project, role: "worker", branch: "feat" }, "e2e")], { cwd, stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(1);
    const msgs = await inbox();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.text).toContain("[agent-exit] worker-feat crashed: agent: no transcript for worker-feat");
  });
});

test("the TUI runs the watchdog for each open page on every inbox poll", async () => {
  const { App } = await import("./tui/app");
  const checked: string[] = [];
  const term = { cols: 40, rows: 8, write() {}, onKey() {}, onResize() {}, open() {}, close() {} };
  const orch = { async say() {}, async pending() { return false; }, async turn() { return []; } };
  const app = new App({ term, openOrchestrator: async () => orch, pollMs: 10, watchdog: async (p) => { checked.push(p); } });
  const running = app.run("watched");
  const deadline = Date.now() + 2000;
  while (checked.length < 2 && Date.now() < deadline) await Bun.sleep(5);
  app.quit();
  await running;
  expect(checked.slice(0, 2)).toEqual(["watched", "watched"]);
});
