import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLayout, paths, saveConfig } from "../config";
import { execution } from "../core/data/projects/lifecycle";
import { put } from "../core/data/inbox";
import { open } from "../core/data/transcripts";
import { launchProcess, readProcess } from "../core/data/processes";
import { cancelSession, cliCommand, publishLaunch } from "../core/tmux";
import { createOrchestrator, runDaemon } from "../core/agent-loop/orc";
import { fakeProvider, text, toolUse } from "../test/fake-provider";
import { runAgent } from "./run";
import { run } from "../core/proc";

const root = mkdtempSync(join(tmpdir(), "orca-stop-tree-"));
process.env.ORCA_HOME = root;
assertLayout(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check() && Date.now() < deadline) await Bun.sleep(20);
  expect(await check()).toBe(true);
}

test("one interrupt ends the daemon, a worker's real shell tree and a detached supervised command; only a new message resumes", async () => {
  const project = "tree"; mkdirSync(paths.repo(project), { recursive: true });
  await saveConfig({ model: "fake", compact: false });
  const t = open(paths.transcript(project, "worker-x"));
  await t.append({ type: "message", message: { role: "user", content: "work" } });
  const marker = join(root, "shell.pid");
  const workerProvider = fakeProvider([[toolUse("shell", "bash", { command: `echo $$ > '${marker}'; sleep 60` })]]);
  const worker = runAgent({ project, role: "worker", branch: "x", loadProvider: async () => workerProvider });
  const background = crypto.randomUUID(), ready = join(root, "background.ready");
  await launchProcess({ id: background, project, owner: "worker-x", role: "worker", cwd: root,
    command: `echo ready > '${ready}'; sleep 60`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    state: "starting", timeoutMs: 60000, maxBytes: 10000, notify: true, events: [] }, cliCommand(), 0);
  const provider = fakeProvider([]);
  let entered = false;
  provider.complete = req => new Promise((_, reject) => { entered = true; req.signal!.addEventListener("abort", () => reject(req.signal!.reason), { once: true }); });
  const session = await createOrchestrator({ project, provider, tools: {}, write() {} });
  publishLaunch(project, "orchestrator", "run");
  await put(project, "orchestrator", { from: "user", text: "start" });
  const daemon = runDaemon({ project, run: "run", session, pollMs: 20, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } });
  try {
    await until(async () => entered && await Bun.file(marker).exists() && await Bun.file(ready).exists());
    const pid = Number(readFileSync(marker, "utf8"));
    await cancelSession(project, "orchestrator");
    expect(await daemon).toBe("stopped"); expect(await worker).toBe(0);
    await until(async () => (await readProcess(project, background)).state === "cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
    await put(project, "orchestrator", { from: "worker-x", text: "old exit notification" });
    expect(execution.stopped(project)).toBe(true);
    const next = fakeProvider([[text("resumed")]]);
    await put(project, "orchestrator", { from: "user", text: "continue" });
    expect(execution.stopped(project)).toBe(false);
    const resumed = await createOrchestrator({ project, provider: next, tools: {}, write() {} });
    try { await runDaemon({ project, run: "next", session: resumed, exitWhenIdle: true, watchers: { watchdog: async () => {}, merges: async () => {} }, log() {} }); }
    finally { resumed.dispose?.(); }
    expect(next.calls).toHaveLength(1);
  } finally { session.dispose?.(); await execution.stop(project); }
}, 15000);
test("interrupt aborts a long watcher command instead of waiting for its timeout", async () => {
  const project = "watcher"; mkdirSync(paths.repo(project), { recursive: true });
  const marker = join(root, "watcher.pid");
  const session = await createOrchestrator({ project, provider: fakeProvider([]), tools: {}, write() {} });
  const daemon = runDaemon({ project, run: "watch", session, log() {}, watchers: { watchdog: async () => {}, merges: async () => {
    await run([process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)},String(process.pid));await Bun.sleep(60000)`], { cwd: root, timeoutMs: 60000 });
  } } });
  try {
    await until(() => Bun.file(marker).exists());
    const pid = Number(readFileSync(marker, "utf8"));
    await cancelSession(project, "orchestrator");
    expect(await daemon).toBe("stopped");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { session.dispose?.(); }
}, 10000);
