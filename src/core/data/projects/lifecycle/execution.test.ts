import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as execution from "./execution";
import { paths } from "../../../../config";
import { put } from "../../inbox/inbox";
import { daemonKeeper, ensureDaemon } from "../../../agent-loop/orc/client";
import { cancelSession, Cancelled, launchEpoch, publishLaunch, watchCancellation } from "../../../tmux/cancellation";
import { makeSpawn } from "../../../tools/spawn";
import { runAgent } from "../../../../exec/run";
import { createAgent } from "../../../agent-loop/loop/agent";
import { open } from "../../transcripts/transcript";
import { pending } from "../../inbox/inbox";
import { fakeProvider, text, toolUse } from "../../../../test/fake-provider";

const root = mkdtempSync(join(tmpdir(), "orca-project-stop-"));
process.env.ORCA_HOME = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
function project(name: string) { mkdirSync(paths.project(name), { recursive: true }); return name; }

test("only newly submitted human input releases the persistent stop barrier", async () => {
  const p = project("resume"), before = execution.epoch(p);
  await execution.stop(p);
  expect(execution.stopped(p)).toBe(true);
  await put(p, "orchestrator", { from: "runtime", text: "command finished" });
  await put(p, "orchestrator", { from: "worker-x", text: "please continue" });
  await put(p, "orchestrator", { from: "user", text: "queued before cancellation", userEpoch: before });
  expect(execution.stopped(p)).toBe(true);
  expect(await ensureDaemon(p, { alive: async () => { throw Error("must not check/start"); } })).toBe("paused");
  expect(await daemonKeeper({ alive: async () => { throw Error("must not restart"); } })(p)).toBeUndefined();
  await put(p, "orchestrator", { from: "user", text: "continue now" });
  expect(execution.stopped(p)).toBe(false);
  expect(execution.stale(p, before)).toBe(true);
});

test("every already admitted role aborts even if a human resumes before its next poll", async () => {
  const p = project("roles"), controllers = [new AbortController(), new AbortController()];
  const off = controllers.map((c, i) => { const id = i ? "reviewer-x" : "worker-x"; publishLaunch(p, id, id); return watchCancellation(p, id, c, id); });
  try {
    await execution.stop(p);
    await put(p, "orchestrator", { from: "user", text: "new request" });
    await Bun.sleep(160);
    for (const c of controllers) expect(c.signal.reason).toBeInstanceOf(Cancelled);
  } finally { off.forEach(f => f()); }
});

test("stopped projects reject direct agent entry and spawn without touching the runner", async () => {
  const p = project("entry");
  await execution.stop(p);
  expect(await runAgent({ project: p, role: "worker", branch: "x", loadProvider: async () => { throw Error("no provider access"); } })).toBe(70);
  const spawn = makeSpawn({ start: async () => { throw Error("must not launch"); }, running: async () => [], stop: async () => {} });
  await expect(spawn.run({ prompt: "stale continuation" }, { project: p, role: "orchestrator", cwd: root })).rejects.toThrow("conversation stopped");
});

test("stop state belongs to the original project incarnation", async () => {
  const p = project("recreated"); await execution.stop(p);
  rmSync(paths.project(p), { recursive: true }); mkdirSync(paths.project(p));
  expect(execution.stopped(p)).toBe(false);
});
test("immutable run admission survives another launch and a rapid resume", async () => {
  const p = project("admission"), original = execution.epoch(p);
  publishLaunch(p, "worker-x", "old");
  await execution.stop(p); await put(p, "orchestrator", { from: "user", text: "resume" });
  publishLaunch(p, "worker-x", "next");
  expect(launchEpoch(p, "worker-x", "old")).toBe(original);
  expect(launchEpoch(p, "worker-x", "next")).toBe(execution.epoch(p));
  expect(await runAgent({ project: p, role: "worker", branch: "x", run: "old", loadProvider: async () => { throw Error("stale provider must not load"); } })).toBe(70);
});
test("a broken task ledger cannot prevent cancellation publication to the remaining roles", async () => {
  const before = process.env.ORCA_HOME; process.env.ORCA_HOME = join(root, "broken-ledger");
  try {
    const p = project("all-roles");
    for (const id of ["orchestrator", "worker-x", "reviewer-x"]) publishLaunch(p, id, id);
    writeFileSync(paths.memory, "invalid SQLite fixture");
    await expect(cancelSession(p, "orchestrator")).rejects.toBeInstanceOf(AggregateError);
    expect(execution.stopped(p)).toBe(true);
    for (const id of ["orchestrator", "worker-x", "reviewer-x"]) expect((await Bun.file(`${paths.transcript(p, id)}.cancel`).json()).run).toBe(id);
  } finally { process.env.ORCA_HOME = before; }
});
test("an old tool boundary cannot consume a new human message after a rapid stop/resume", async () => {
  const p = project("boundary"), transcript = open(paths.transcript(p, "orchestrator"));
  await transcript.append({ type: "message", message: { role: "user", content: "original" } });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const provider = fakeProvider([[toolUse("one", "pause", {})]]);
  const original = createAgent({ transcript, provider, model: "fake", compaction: { enabled: false },
    ctx: { project: p, role: "orchestrator", cwd: root, executionEpoch: execution.epoch(p) },
    tools: { pause: { spec: { name: "pause", description: "pause", input_schema: { type: "object" } }, run: async () => { entered.resolve(); await release.promise; return "completed result"; } } }, write() {} });
  const running = original.run(); await entered.promise;
  await execution.stop(p); await put(p, "orchestrator", { from: "user", text: "new instruction" });
  release.resolve();
  await expect(running).rejects.toBeInstanceOf(Cancelled);
  expect(provider.calls).toHaveLength(1);
  expect(await pending(p, "orchestrator")).toBe(true);
  expect(JSON.stringify(await transcript.chain())).toContain("completed result");
  const resumed = fakeProvider([[text("new request completed")]]);
  await createAgent({ transcript, provider: resumed, model: "fake", tools: {}, requireInbox: true, compaction: { enabled: false },
    ctx: { project: p, role: "orchestrator", cwd: root, executionEpoch: execution.epoch(p) }, write() {} }).run();
  expect(resumed.calls).toHaveLength(1); expect(await pending(p, "orchestrator")).toBe(false);
});
test("a new message waits for an old generation to exit before starting its daemon replacement", async () => {
  const p = project("retire"), child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], { stdout: "ignore", stderr: "ignore" });
  publishLaunch(p, "orchestrator", "old-run");
  mkdirSync(paths.daemonLock(p), { recursive: true });
  writeFileSync(join(paths.daemonLock(p), "owner.json"), JSON.stringify({ pid: child.pid, since: new Date().toISOString() }));
  await execution.stop(p); await put(p, "orchestrator", { from: "user", text: "resume immediately" });
  let starts = 0;
  const starting = ensureDaemon(p, { runner: { start: async () => { starts++; }, running: async () => [], stop: async () => {} } });
  try {
    const dir = join(paths.orchestrator(p), "commands"), deadline = Date.now() + 3000;
    while ((!existsSync(dir) || !readdirSync(dir).length) && Date.now() < deadline) await Bun.sleep(5);
    expect(starts).toBe(0);
    expect(readdirSync(dir)).not.toHaveLength(0);
    child.kill("SIGTERM"); await child.exited;
    expect(await starting).toBe("started"); expect(starts).toBe(1);
  } finally { child.kill(); await child.exited; }
});
