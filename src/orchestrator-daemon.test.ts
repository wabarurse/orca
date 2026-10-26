import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteRequest } from "./providers/index";
import { Cancelled, cancelSession, publishLaunch } from "./cancellation";
import { paths, saveConfig } from "./config";
import { pending, put } from "./inbox";
import { createOrchestrator } from "./orchestrator";
import { acknowledge, awaitAck, daemonBusy, pruneAcks, readStatus, request, takeRequests, writeStatus } from "./orchestrator-channel";
import { orchestratorAgent, runDaemon, type DaemonOptions } from "./orchestrator-daemon";
import { claimed, readRun } from "./exits";
import { saveProjectModel } from "./project-model";
import { tryStorageLock } from "./storage-lock";
import { fakeProvider, text } from "./test/fake-provider";
import { open } from "./transcript";
import { inputEpoch } from "./user-input";

const home = mkdtempSync(join(tmpdir(), "orca-daemon-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await check()).toBe(true);
}

/** A clock the test advances, and a sleep the test wakes: the loop never waits on real time. */
function fakeClock() {
  let now = 1_000_000;
  const sleepers: (() => void)[] = [];
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
    sleep: () => new Promise<void>(resolve => { sleepers.push(resolve); }),
    wake() { for (const s of sleepers.splice(0)) s(); },
    sleeping: () => sleepers.length,
  };
}

async function project(name: string) {
  mkdirSync(paths.repo(name), { recursive: true });
  await saveConfig({ model: "fake-model", compact: false });
  return name;
}

test("the loop runs turns on input, the watchers on their interval, answers requests and stops on request; nothing waits on real time", async () => {
  const p = await project("loop");
  const provider = fakeProvider([[text("first reply")], [text("second reply")]]);
  const session = await createOrchestrator({ project: p, provider, tools: {}, write() {} });
  const clock = fakeClock();
  let watched = 0, merged = 0;
  const opts: DaemonOptions = { project: p, run: "run-1", session, sleep: clock.sleep, now: clock.now, watchMs: 2000, log() {},
    watchers: { watchdog: async () => { watched++; }, merges: async () => { merged++; } } };
  await put(p, "orchestrator", { from: "user", text: "hello" });
  const running = runDaemon(opts);
  await until(() => readStatus(p)?.turns === 1 && readStatus(p)?.state === "idle");
  expect(provider.calls).toHaveLength(1);
  expect(await pending(p, "orchestrator")).toBe(false);
  expect(readStatus(p)).toMatchObject({ pid: process.pid, run: "run-1", context: { model: "fake-model" } });
  expect(readStatus(p)!.context!.used).toBeGreaterThan(0);
  expect(watched).toBe(1); expect(merged).toBe(1);
  await until(() => clock.sleeping() === 1); // idle: parked on the injected sleep
  // Woken early without the interval passing: no watcher run; input is still picked up.
  await put(p, "orchestrator", { from: "user", text: "again" });
  clock.wake();
  await until(() => readStatus(p)?.turns === 2 && readStatus(p)?.state === "idle");
  expect(provider.calls).toHaveLength(2);
  expect(watched).toBe(1);
  await until(() => clock.sleeping() === 1);
  clock.advance(2000); clock.wake();
  await until(() => watched === 2 && merged === 2);
  // Requests are answered in order, under their ids; a wrong model is refused, the saved one confirmed.
  await until(() => clock.sleeping() === 1);
  const compact = await request(p, { kind: "compact" });
  const wrong = await request(p, { kind: "model", model: "other-model" });
  await saveProjectModel(p, "claude-opus-5-5");
  const right = await request(p, { kind: "model", model: "claude-opus-5-5" });
  clock.wake();
  expect(await awaitAck(p, compact, { alive: async () => true })).toMatchObject({ ok: true, message: expect.stringContaining("compaction requested") });
  expect(await awaitAck(p, wrong, { alive: async () => true })).toMatchObject({ ok: false, message: "the saved model is claude-opus-5-5, not other-model" });
  expect(await awaitAck(p, right, { alive: async () => true })).toMatchObject({ ok: true, message: "model claude-opus-5-5 applies from the orchestrator's next request" });
  await until(() => clock.sleeping() === 1);
  const stop = await request(p, { kind: "stop" });
  clock.wake();
  expect(await running).toBe("stopped");
  expect((await awaitAck(p, stop, { alive: async () => true })).ok).toBe(true);
  expect(readStatus(p)?.state).toBe("stopped");
  expect(await takeRequests(p)).toEqual([]);
  session.dispose?.();
});

test("a cancel request for this launch aborts the running turn, pauses input and is acknowledged under its token", async () => {
  const p = await project("cancel");
  const transcript = open(paths.transcript(p, "orchestrator"));
  let aborted = false;
  const provider = fakeProvider([]);
  provider.complete = (req: CompleteRequest) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => { aborted = true; reject(new Cancelled()); }));
  const session = await createOrchestrator({ project: p, provider, tools: {}, write() {}, transcript });
  const clock = fakeClock();
  const release = await tryStorageLock(paths.daemonLock(p), p); // the daemon process holds it for life; the test stands in
  const running = runDaemon({ project: p, run: "run-c", session, sleep: clock.sleep, now: clock.now, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } });
  await until(() => clock.sleeping() === 1);
  expect(await daemonBusy(p)).toBe(false);
  await put(p, "orchestrator", { from: "user", text: "work" });
  clock.wake();
  await until(() => readStatus(p)?.state === "turn");
  expect(await daemonBusy(p)).toBe(true);
  publishLaunch(p, "orchestrator", "run-c");
  const epoch = inputEpoch(p);
  const token = (await cancelSession(p, "orchestrator"))!;
  const ack = await awaitAck(p, token, { alive: async () => true });
  expect(ack.ok).toBe(true);
  expect(aborted).toBe(true);
  await until(() => readStatus(p)?.state === "idle");
  expect(inputEpoch(p)).not.toBe(epoch);
  expect(existsSync(`${paths.transcript(p, "orchestrator")}.cancel`)).toBe(false);
  // Paused: the consumed pre-cancel input does not run again; the loop idles.
  await until(() => clock.sleeping() === 1);
  expect(await session.pending()).toBe(false);
  const stop = await request(p, { kind: "stop" });
  clock.wake();
  expect(await running).toBe("stopped");
  expect((await awaitAck(p, stop, { alive: async () => true })).ok).toBe(true);
  await release!();
  session.dispose?.();
});

test("a failed turn is published and the loop goes on; a deleted project ends it without writing; exitWhenIdle ends it once idle", async () => {
  const p = await project("failing");
  const provider = fakeProvider([]);
  provider.complete = async () => { throw new Error("provider down"); };
  const session = await createOrchestrator({ project: p, provider, tools: {}, write() {} });
  const clock = fakeClock();
  const logged: string[] = [];
  let gone = false;
  const running = runDaemon({ project: p, run: "run-f", session, sleep: clock.sleep, now: clock.now, log: t => { logged.push(t); }, gone: () => gone, watchers: { watchdog: async () => {}, merges: async () => {} } });
  await until(() => clock.sleeping() === 1);
  await put(p, "orchestrator", { from: "user", text: "try" });
  clock.wake();
  await until(() => readStatus(p)?.state === "idle" && readStatus(p)?.turns === 1);
  expect(readStatus(p)?.error).toBe("provider down");
  expect(logged.some(t => t.includes("turn failed: provider down"))).toBe(true);
  await until(() => clock.sleeping() === 1);
  gone = true; clock.wake();
  expect(await running).toBe("deleted");
  expect(readStatus(p)?.state).toBe("idle"); // nothing written after the project went away
  session.dispose?.();

  const q = await project("once");
  const once = await createOrchestrator({ project: q, provider: fakeProvider([[text("ok")]]), tools: {}, write() {} });
  await put(q, "orchestrator", { from: "user", text: "one" });
  expect(await runDaemon({ project: q, run: "run-o", session: once, exitWhenIdle: true, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } })).toBe("idle");
  expect(readStatus(q)).toMatchObject({ state: "stopped", turns: 1 });
  once.dispose?.();
});

test("clear through the channel appends the boundary; a request while input is pending is refused in the ack", async () => {
  const p = await project("clearing");
  const transcript = open(paths.transcript(p, "orchestrator"));
  const session = await createOrchestrator({ project: p, provider: fakeProvider([[text("hi")]]), tools: {}, write() {}, transcript });
  const clock = fakeClock();
  const release = await tryStorageLock(paths.daemonLock(p), p);
  const running = runDaemon({ project: p, run: "run-x", session, sleep: clock.sleep, now: clock.now, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } });
  await until(() => clock.sleeping() === 1);
  await put(p, "orchestrator", { from: "user", text: "chat" });
  clock.wake();
  await until(() => readStatus(p)?.turns === 1 && readStatus(p)?.state === "idle");
  await until(() => clock.sleeping() === 1);
  const clear = await request(p, { kind: "clear" });
  clock.wake();
  expect(await awaitAck(p, clear)).toMatchObject({ ok: true, message: "model context cleared" });
  expect(transcript.history!().at(-1)?.type).toBe("context-boundary");
  await until(() => clock.sleeping() === 1);
  await put(p, "orchestrator", { from: "user", text: "pending" }); // lands before the request runs: the clear is refused
  const refused = await request(p, { kind: "clear" });
  clock.wake();
  expect(await awaitAck(p, refused)).toMatchObject({ ok: false, message: expect.stringContaining("input is pending") });
  await until(() => readStatus(p)?.turns === 2 && readStatus(p)?.state === "idle").catch(() => {}); // the pending chat then runs out of script: a failed turn, not a crash
  await until(() => clock.sleeping() === 1);
  const stop = await request(p, { kind: "stop" });
  clock.wake();
  expect(await running).toBe("stopped");
  await awaitAck(p, stop);
  await release!();
  session.dispose?.();
});

test("channel: acks are collected once, pruned when stale, and waiting fails fast when the daemon is dead", async () => {
  const p = await project("channel");
  await acknowledge(p, "a1", true, "done");
  expect(await awaitAck(p, "a1", { alive: async () => true })).toMatchObject({ id: "a1", ok: true, message: "done" });
  await expect(awaitAck(p, "a1", { alive: async () => false })).rejects.toThrow("orchestrator is not running");
  await expect(awaitAck(p, "a1", { alive: async () => true, timeoutMs: 50 })).rejects.toThrow("did not acknowledge");
  await acknowledge(p, "old", true, "stale");
  await pruneAcks(p, Date.now() + 2 * 60 * 60 * 1000);
  await expect(awaitAck(p, "old", { alive: async () => true, timeoutMs: 20 })).rejects.toThrow("did not acknowledge");
  // A stale status from a dead process never reads as busy.
  await writeStatus(p, { pid: 2 ** 22 - 1, run: "dead", state: "turn", since: "", turns: 1 });
  expect(await daemonBusy(p)).toBe(false);
  expect(readStatus("nowhere")).toBeUndefined();
});

test("orchestratorAgent: supervised run record, a clean idle exit claims its run (no notice), a second instance exits 70 without a record, deletion exits at once", async () => {
  const p = await project("agent");
  await put(p, "orchestrator", { from: "user", text: "go" });
  const provider = fakeProvider([[text("done")]]);
  expect(await orchestratorAgent({ project: p, role: "orchestrator", run: "run-a", loadProvider: async () => provider, exitWhenIdle: true })).toBe(0);
  const state = await readRun(p, "orchestrator");
  expect(state).toMatchObject({ run: "run-a", role: "orchestrator", pid: process.pid });
  expect(state?.endedAt).toBeString();
  expect(claimed(p, "orchestrator", "run-a")).toBe(true);
  expect(await pending(p, "orchestrator")).toBe(false); // no [agent-exit] for a clean stop
  expect(provider.calls).toHaveLength(1);

  const held = await tryStorageLock(paths.daemonLock(p), p);
  const stderr = console.error; const logged: string[] = [];
  console.error = (t: string) => { logged.push(String(t)); };
  try { expect(await orchestratorAgent({ project: p, role: "orchestrator", run: "run-b", loadProvider: async () => provider })).toBe(70); }
  finally { console.error = stderr; }
  expect(logged.some(t => t.includes("already running"))).toBe(true);
  expect((await readRun(p, "orchestrator"))?.run).toBe("run-a"); // the loser wrote no record: its launch fails as a death before start
  await held!();

  const q = await project("vanishing");
  const exits: number[] = [];
  const running = orchestratorAgent({ project: q, role: "orchestrator", run: "run-v", loadProvider: async () => provider }, code => { exits.push(code); });
  await until(() => readStatus(q)?.state === "idle");
  rmSync(paths.project(q), { recursive: true, force: true });
  await until(() => exits.length === 1, 4000);
  expect(exits).toEqual([0]);
  await Bun.sleep(50);
  expect(existsSync(paths.project(q))).toBe(false); // nothing written back: the process is gone before supervise could close the run
  void running; // never settles here, as a process that exited
});
