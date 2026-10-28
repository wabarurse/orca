import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteRequest } from "../../../providers/provider";
import { Cancelled, cancelSession, launchIdentity, publishLaunch } from "../../tmux/cancellation";
import { conversationTurnLock, projectTurnLock, turnLocksHeld } from "../../data/projects/state";
import { paths, saveConfig } from "../../../config/config";
import { pending, put } from "../../data/inbox/inbox";
import { createOrchestrator } from "./orchestrator";
import { acknowledge, awaitAck, daemonBusy, pruneAcks, readStatus, request, takeRequests, writeStatus } from "./channel";
import { runDaemon, windowHooks, type DaemonOptions } from "./daemon";
import { orchestratorAgent } from "../../../exec/daemon";
import { liveFile, liveReader, liveWriter } from "./live";
import type { LiveEvent } from "../../../protocol/daemon";
import { claimed, readRun } from "../../tmux/exits";
import { saveProjectModel } from "../../data/projects/project-model";
import { lockHeld, tryStorageLock } from "../../data/storage-lock";
import { writeFileSync } from "node:fs";
import { fakeProvider, text, toolUse } from "../../../test/fake-provider";
import type { Tool } from "../../tools/registry";
import { open } from "../../data/transcripts/transcript";
import { inputEpoch } from "../../data/inbox/user-input";

const home = mkdtempSync(join(tmpdir(), "orca-daemon-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
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
  await until(() => watched === 1 && merged === 1); // the pass runs beside the turn, not before it
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
  // Requests are answered in order, under their ids; a model request is answered with whatever is saved by then.
  await until(() => clock.sleeping() === 1);
  const compact = await request(p, { kind: "compact" });
  const wrong = await request(p, { kind: "model", model: "other-model" });
  await saveProjectModel(p, "claude-opus-5-5");
  const right = await request(p, { kind: "model", model: "claude-opus-5-5" });
  clock.wake();
  expect(await awaitAck(p, compact, { alive: async () => true })).toMatchObject({ ok: true, message: expect.stringContaining("compaction requested") });
  expect(await awaitAck(p, wrong, { alive: async () => true })).toMatchObject({ ok: true, message: "model claude-opus-5-5 applies from the orchestrator's next request" });
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

test("input sent while the orchestrator is idle starts its turn at once, not after a slow watcher pass (gh per task PR)", async () => {
  const p = await project("slow-watch");
  const provider = fakeProvider([[text("first reply")], [text("second reply")]]);
  const session = await createOrchestrator({ project: p, provider, tools: {}, write() {} });
  const clock = fakeClock();
  const gh = deferred();
  let merges = 0, finished = 0;
  const running = runDaemon({ project: p, run: "run-w", session, sleep: clock.sleep, now: clock.now, watchMs: 2000, log() {},
    watchers: { watchdog: async () => {}, merges: async () => { merges++; await gh.promise; finished++; } } });
  await until(() => merges === 1 && clock.sleeping() === 1); // idle, its first watcher pass still waiting on gh
  await put(p, "orchestrator", { from: "user", text: "sent while gh runs" });
  clock.wake();
  await until(() => readStatus(p)?.turns === 1 && readStatus(p)?.state === "idle");
  expect(provider.calls).toHaveLength(1);
  expect(await pending(p, "orchestrator")).toBe(false);
  expect(finished).toBe(0);
  // A due interval starts no second pass while one is in flight; input still goes through.
  await until(() => clock.sleeping() === 1);
  clock.advance(2000);
  await put(p, "orchestrator", { from: "user", text: "again" });
  clock.wake();
  await until(() => readStatus(p)?.turns === 2 && readStatus(p)?.state === "idle");
  expect(merges).toBe(1);
  gh.resolve();
  await until(() => finished === 1);
  await until(() => clock.sleeping() === 1);
  const stop = await request(p, { kind: "stop" });
  clock.wake();
  expect(await running).toBe("stopped");
  expect((await awaitAck(p, stop, { alive: async () => true })).ok).toBe(true);
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
  expect(ack).toMatchObject({ ok: true, message: expect.stringContaining("turn cancelled") });
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
  // A restart while waiting: the request will never be answered, so the wait ends at once.
  const runs = ["r1", "r1", "r2"];
  await expect(awaitAck(p, "never", { alive: async () => true, run: async () => runs.shift() })).rejects.toThrow("orchestrator restarted");
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
  expect(launchIdentity(p, "orchestrator")).toBe("run-a"); // the daemon asserts its own launch once it holds the lock
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
  expect(await running).toBe(0); // in-process the outcome comes back; the CLI's `exit` is process.exit and never returns
  await Bun.sleep(50);
  expect(existsSync(paths.project(q))).toBe(false); // nothing written back: the run is abandoned, never closed
  const silent = await project("vanishing-silently");
  const silently = orchestratorAgent({ project: silent, role: "orchestrator", run: "run-w", loadProvider: async () => provider });
  await until(() => readStatus(silent)?.state === "idle");
  rmSync(paths.project(silent), { recursive: true, force: true });
  expect(await silently).toBe(0); // no injected exit: the process (a test runner, say) goes on
  await Bun.sleep(50);
  expect(existsSync(paths.project(silent))).toBe(false);
});

test("a foreign .launch (a start that lost the lock race, published last) is re-asserted by the live daemon, so a cancel still reaches it", async () => {
  const p = await project("launch-race");
  const session = await createOrchestrator({ project: p, provider: fakeProvider([]), tools: {}, write() {} });
  const clock = fakeClock();
  const release = await tryStorageLock(paths.daemonLock(p), p);
  publishLaunch(p, "orchestrator", "loser-run");
  const running = runDaemon({ project: p, run: "winner-run", session, sleep: clock.sleep, now: clock.now, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } });
  await until(() => clock.sleeping() === 1);
  expect(launchIdentity(p, "orchestrator")).toBe("winner-run");
  publishLaunch(p, "orchestrator", "loser-run"); // a loser's publish landing after the winner's first pass
  clock.wake();
  await until(() => clock.sleeping() === 1);
  expect(launchIdentity(p, "orchestrator")).toBe("winner-run");
  const token = (await cancelSession(p, "orchestrator"))!;
  clock.wake();
  expect(await awaitAck(p, token)).toMatchObject({ ok: true, message: expect.stringContaining("nothing was running") });
  await until(() => clock.sleeping() === 1);
  const stop = await request(p, { kind: "stop" });
  clock.wake();
  expect(await running).toBe("stopped");
  await awaitAck(p, stop);
  await release!();
  session.dispose?.();
});

test("compact and model requests are answered during a running turn; clear and stop wait for it to end", async () => {
  const p = await project("in-turn");
  const gate = deferred();
  const provider = fakeProvider([[text("late reply")]]);
  const complete = provider.complete;
  provider.complete = async (req: CompleteRequest) => { await gate.promise; return complete(req); };
  const session = await createOrchestrator({ project: p, provider, tools: {}, write() {} });
  const clock = fakeClock();
  const release = await tryStorageLock(paths.daemonLock(p), p);
  const running = runDaemon({ project: p, run: "run-t", session, sleep: clock.sleep, now: clock.now, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } });
  await until(() => clock.sleeping() === 1);
  await put(p, "orchestrator", { from: "user", text: "slow" });
  clock.wake();
  await until(() => readStatus(p)?.state === "turn");
  const clear = await request(p, { kind: "clear" });
  const compact = await request(p, { kind: "compact" });
  await saveProjectModel(p, "claude-opus-5-5");
  const model = await request(p, { kind: "model", model: "claude-sonnet-5-5" }); // overtaken by a newer switch: still answered with what is saved
  expect(await awaitAck(p, compact)).toMatchObject({ ok: true, message: expect.stringContaining("next safe boundary") });
  expect(await awaitAck(p, model)).toMatchObject({ ok: true, message: "model claude-opus-5-5 applies from the orchestrator's next request" });
  expect(readStatus(p)?.state).toBe("turn");
  await expect(awaitAck(p, clear, { timeoutMs: 300 })).rejects.toThrow("did not acknowledge"); // not between turns yet
  gate.resolve();
  expect(await awaitAck(p, clear)).toMatchObject({ ok: true, message: "model context cleared" }); // answered once the turn (which consumed the compaction flag at its boundary) ended
  expect(readStatus(p)).toMatchObject({ state: "idle", turns: 1 });
  await until(() => clock.sleeping() === 1);
  const stop = await request(p, { kind: "stop" });
  clock.wake();
  expect(await running).toBe("stopped");
  await awaitAck(p, stop);
  await release!();
  session.dispose?.();
});

test("turn locks left by a dead owner (a daemon killed mid-turn) do not gate the next daemon or a clear", async () => {
  const p = await project("stale-locks");
  const dead = { pid: 2 ** 22 - 1, since: "2026-01-01T00:00:00.000Z", project: p };
  for (const lock of new Set([projectTurnLock(p), conversationTurnLock(p)])) {
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(dead));
    expect(await lockHeld(lock)).toBe(false);
  }
  expect(await turnLocksHeld(p)).toBe(false);
  const live = await tryStorageLock(join(home, "some-other-lock"), p);
  expect(await lockHeld(join(home, "some-other-lock"))).toBe(true);
  await live!();
  const session = await createOrchestrator({ project: p, provider: fakeProvider([[text("after takeover")]]), tools: {}, write() {} });
  await put(p, "orchestrator", { from: "user", text: "go" });
  expect(await session.pending()).toBe(true);
  expect(await runDaemon({ project: p, run: "run-s", session, exitWhenIdle: true, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } })).toBe("idle");
  expect(readStatus(p)).toMatchObject({ turns: 1 });
  expect(readStatus(p)?.error).toBeUndefined();
  expect(await turnLocksHeld(p)).toBe(false);
  await session.checkClear!(); // not refused by the stale locks either
  session.dispose?.();
});

test("a turn streams its text, tool starts and ends to the live file, keyed by run and turn and tagged with the transcript head; the file is gone once the turn's entries are durable", async () => {
  const p = await project("live");
  const transcript = open(paths.transcript(p, "orchestrator"));
  const gate = deferred();
  const echo: Tool = { spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: {} } }, run: async input => { await gate.promise; return `echo ${input.text}`; } };
  const provider = fakeProvider([[text("look"), text("ing"), toolUse("t1", "echo", { text: "hi" })], [text("done")]]);
  const complete = provider.complete, second = deferred();
  provider.complete = async (req: CompleteRequest) => { if (provider.calls.length === 1) await second.promise; return complete(req); };
  const window: string[] = [];
  const live = liveWriter({ project: p, run: "run-l", head: () => transcript.head(), log() {} });
  const session = await createOrchestrator({ project: p, provider, tools: { echo }, transcript, ...windowHooks(live, t => { window.push(t); }) });
  const clock = fakeClock();
  const running = runDaemon({ project: p, run: "run-l", session, live, sleep: clock.sleep, now: clock.now, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} } });
  await until(() => clock.sleeping() === 1);
  expect(existsSync(liveFile(p))).toBe(false);
  await put(p, "orchestrator", { from: "user", text: "go" });
  clock.wake();
  const reader = liveReader(p);
  const seen: LiveEvent[] = [];
  // Follow the file while the tool waits: the streamed text and the tool start are there, each tagged with the head it followed.
  await until(() => { const s = readStatus(p); if (s?.state === "turn") seen.push(...reader.read({ run: s.run, turn: s.turns })); return seen.some(e => e.kind === "tool_start"); });
  expect(seen[0]).toMatchObject({ seq: 0, kind: "start", run: "run-l", turn: 1 });
  expect(seen.map(e => e.seq)).toEqual(seen.map((_, i) => i));
  const texts = seen.filter(e => e.kind === "text") as Extract<LiveEvent, { kind: "text" }>[];
  expect(texts.map(e => e.text)).toEqual(["look", "ing", "\n"]);
  const entries = transcript.history!();
  const inboxEntry = entries.find(e => e.type === "message" && e.message.role === "user")!;
  const reply = entries.find(e => e.type === "message" && e.message.role === "assistant")!;
  expect(texts[0]!.head).toBe(inboxEntry.uuid); // streamed after the input was consumed, before the reply was appended
  expect(seen.at(-1)).toMatchObject({ kind: "tool_start", head: reply.uuid, call: { id: "t1", name: "echo", input: { text: "hi" } } });
  expect(entries.at(-1)!.uuid).toBe(reply.uuid); // the tool's result is not durable yet: only the live file has the running call
  gate.resolve();
  // The tool ended (its end is tagged with the reply, before its result is appended) and the next request waits.
  await until(() => { const s = readStatus(p)!; seen.push(...reader.read({ run: s.run, turn: s.turns })); return seen.some(e => e.kind === "tool_end"); });
  expect(seen.at(-1)).toMatchObject({ kind: "tool_end", head: reply.uuid, outcome: { id: "t1", ok: true, text: "echo hi" } });
  expect(readStatus(p)?.state).toBe("turn");
  second.resolve();
  await until(() => readStatus(p)?.state === "idle");
  expect(existsSync(liveFile(p))).toBe(false); // rotated before the status said idle
  const s = readStatus(p)!;
  expect(reader.read({ run: s.run, turn: s.turns })).toEqual([]);
  // The window showed the same turn: streamed text, the call line and its result line.
  expect(window.join("")).toContain("looking\n");
  expect(window.join("")).toContain("echo(hi)");
  expect(window.some(t => t.includes("⎿"))).toBe(true);
  await until(() => clock.sleeping() === 1);
  const stop = await request(p, { kind: "stop" });
  clock.wake();
  expect(await running).toBe("stopped");
  expect((await awaitAck(p, stop, { alive: async () => true })).ok).toBe(true);
  session.dispose?.();
});
