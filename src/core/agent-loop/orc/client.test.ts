import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteRequest } from "../../../providers/provider";
import { publishLaunch } from "../../tmux/cancellation";
import { paths, saveConfig } from "../../../config/config";
import { createOrchestrator } from "./orchestrator";
import { readStatus, request } from "./channel";
import { createClientOrchestrator, daemonKeeper, ensureDaemon, stopDaemon } from "./client";
import { runDaemon } from "./daemon";
import { saveProjectModel } from "../../data/projects/project-model";
import type { Runner, StartOptions } from "../../tmux/runner";
import { tryStorageLock } from "../../data/storage-lock";
import { fakeProvider, text, toolUse } from "../../../test/fake-provider";
import type { Tool } from "../../tools/registry";
import { windowHooks } from "./daemon";
import { liveWriter } from "./live";
import { open } from "../../data/transcripts/transcript";

const home = mkdtempSync(join(tmpdir(), "orca-client-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(5);
  expect(await check()).toBe(true);
}
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("a client round trip with a live daemon: say, follow the turn from disk, cancel, compact, model and clear acknowledged; nothing runs in the client", async () => {
  const p = "client";
  mkdirSync(paths.repo(p), { recursive: true });
  await saveConfig({ model: "fake-model", compact: false });
  const gate = deferred();
  const provider = fakeProvider([[text("reply one")], [text("reply two")]]);
  const complete = provider.complete;
  provider.complete = async (req: CompleteRequest) => { await gate.promise; return complete(req); };
  const session = await createOrchestrator({ project: p, provider, tools: {}, write() {} });
  const release = await tryStorageLock(paths.daemonLock(p), p);
  publishLaunch(p, "orchestrator", "run-d");
  const daemon = runDaemon({ project: p, run: "run-d", session, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} }, sleep: () => Bun.sleep(20) });
  await until(() => readStatus(p)?.state === "idle");

  let refreshes = 0;
  const notices: string[] = [];
  const client = await createClientOrchestrator({ project: p, onRefresh: () => { refreshes++; }, notice: t => { notices.push(t); }, followMs: 10, graceMs: 2000 });
  expect(await client.pending()).toBe(false);
  await client.say("hello", client.submission!(), "input-1");
  const turn = client.turn(); // follows: the daemon has not started yet, the grace covers its poll
  await until(() => readStatus(p)?.state === "turn");
  expect(await client.pending()).toBe(false); // already following
  await expect(client.checkClear!()).rejects.toThrow("running or compacting");
  gate.resolve();
  await turn;
  expect(readStatus(p)).toMatchObject({ state: "idle", turns: 1 });
  expect(refreshes).toBeGreaterThan(0);
  expect(client.consumed!().has("input-1")).toBe(true);
  expect(client.entries!().some(e => e.type === "message" && e.message.role === "assistant")).toBe(true);
  expect(client.contextUsage!("fake-model")).toBeGreaterThan(0);
  expect(client.contextWindow!("fake-model").limit).toBeGreaterThan(0);
  expect(client.contextUsage!("other")).toBeUndefined();

  // Requests are answered by the daemon; the client reports the acknowledgement.
  await client.compact!();
  expect(notices.at(-1)).toContain("compaction requested");
  await saveProjectModel(p, "claude-opus-5-5");
  expect(await client.observeModel!("claude-opus-5-5")).toBe("model claude-opus-5-5 applies from the orchestrator's next request");
  await client.clear!();
  expect(client.entries!().at(-1)?.type).toBe("context-boundary");
  expect(provider.calls).toHaveLength(1);
  client.cancel!();
  await until(() => notices.some(t => t.includes("conversation stopped")));
  expect(await daemon).toBe("stopped");
  client.dispose?.();
  await release!();
  session.dispose?.();
});

test("ensureDaemon starts through the runner only when none is alive; a lost start race still counts as running; the keeper backs off", async () => {
  const started: StartOptions[] = [];
  let alive = false, fail = false;
  const runner: Runner = { async start(o) { started.push(o); if (fail) throw new Error("window died"); alive = true; }, async stop() {}, async running() { return []; } };
  const isAlive = async () => alive;
  expect(await ensureDaemon("e", { runner, alive: isAlive })).toBe("started");
  expect(started).toEqual([{ project: "e", role: "orchestrator", signal: undefined }]);
  expect(await ensureDaemon("e", { runner, alive: isAlive })).toBe("running");
  alive = false; fail = true;
  await expect(ensureDaemon("e", { runner, alive: isAlive })).rejects.toThrow("window died");
  const racer: Runner = { ...runner, async start(o) { started.push(o); alive = true; throw new Error("orchestrator exited (code 70) before the agent started"); } };
  expect(await ensureDaemon("e", { runner: racer, alive: isAlive })).toBe("running");

  let now = 0;
  alive = false; fail = false; started.length = 0;
  const keep = daemonKeeper({ runner, alive: isAlive, now: () => now });
  expect(await keep("k")).toBeUndefined(); // the first start is routine: no line
  expect(started).toHaveLength(1);
  expect(await keep("k")).toBeUndefined(); // alive now
  alive = false;
  expect(await keep("k")).toBeUndefined(); // dead again, but inside the backoff
  expect(started).toHaveLength(1);
  now += 20_000;
  expect(await keep("k")).toBe("orchestrator was not running; restarted");
  expect(started).toHaveLength(2);
  alive = false; fail = true; now += 20_000;
  await expect(keep("k")).rejects.toThrow("window died");
});

test("stopDaemon asks first, then kills the window, and waits for the recorded process either way", async () => {
  const p = "stopping";
  mkdirSync(paths.project(p), { recursive: true });
  expect(await stopDaemon(p)).toBeUndefined(); // nothing running: nothing to do
  const child = Bun.spawn(["sleep", "30"]);
  mkdirSync(paths.daemonLock(p), { recursive: true });
  writeFileSync(join(paths.daemonLock(p), "owner.json"), JSON.stringify({ pid: child.pid, since: new Date().toISOString(), project: p }));
  let killed = 0;
  await stopDaemon(p, { waitMs: 200, kill: async () => { killed++; child.kill(); } });
  expect(killed).toBe(1);
  expect(readdirSync(join(paths.orchestrator(p), "commands")).some(n => n.endsWith(".json"))).toBe(true); // the stop request went out first
  const stubborn = Bun.spawn(["sleep", "30"]);
  writeFileSync(join(paths.daemonLock(p), "owner.json"), JSON.stringify({ pid: stubborn.pid, since: new Date().toISOString(), project: p }));
  await expect(stopDaemon(p, { waitMs: 100, killWaitMs: 100, kill: async () => {} })).rejects.toThrow("did not stop");
  stubborn.kill();
});

/** A client whose view hooks record what they got, in order. */
async function viewer(project: string) {
  const got: string[] = [];
  const client = await createClientOrchestrator({ project, followMs: 10, graceMs: 2000,
    onRefresh: () => { got.push("refresh"); }, notice: t => { got.push(`notice ${t}`); },
    write: (t, plain) => { got.push(`${plain ? "plain" : "text"} ${JSON.stringify(t)}`); },
    onTool: call => { got.push(`tool ${call.id} ${call.name}`); }, onToolResult: outcome => { got.push(`end ${outcome.id} ${outcome.ok}`); } });
  return { client, got };
}
const count = (got: string[], item: string) => got.filter(g => g === item).length;

test("following clients get the turn's live text and tool events through the in-process hooks, once each and never for what a durable entry already shows; a client attaching mid-turn replays the file, then tails it", async () => {
  const p = "live-follow";
  mkdirSync(paths.repo(p), { recursive: true });
  await saveConfig({ model: "fake-model", compact: false });
  const transcript = open(paths.transcript(p, "orchestrator"));
  const gates = { look: deferred(), ing: deferred(), tool: deferred(), done: deferred() };
  const echo: Tool = { spec: { name: "echo", description: "echo", input_schema: { type: "object", properties: {} } }, run: async () => { await gates.tool.promise; return "echoed"; } };
  const provider = fakeProvider([]);
  provider.complete = async (req: CompleteRequest) => {
    provider.calls.push({ messages: req.messages, tools: [] });
    if (provider.calls.length === 1) {
      req.onText("look"); await gates.look.promise; req.onText("ing"); await gates.ing.promise;
      return { completion: "end_turn", content: [text("looking"), toolUse("t1", "echo", {})], stop: "tool_use" as const };
    }
    req.onText("done"); await gates.done.promise;
    return { completion: "end_turn", content: [text("done")], stop: "end" as const };
  };
  const live = liveWriter({ project: p, run: "run-f", head: () => transcript.head(), log() {} });
  const session = await createOrchestrator({ project: p, provider, tools: { echo }, transcript, ...windowHooks(live, () => {}) });
  const release = await tryStorageLock(paths.daemonLock(p), p);
  publishLaunch(p, "orchestrator", "run-f");
  const daemon = runDaemon({ project: p, run: "run-f", session, live, log() {}, watchers: { watchdog: async () => {}, merges: async () => {} }, sleep: () => Bun.sleep(20) });
  await until(() => readStatus(p)?.state === "idle");

  const a = await viewer(p);
  await a.client.say("hello", a.client.submission!(), "input-a");
  const turnA = a.client.turn();
  await until(() => a.got.includes('text "look"'));
  expect(a.got.indexOf("refresh")).toBeLessThan(a.got.indexOf('text "look"')); // the consumed input landed first
  // A second TUI opens now: it replays the file (the text streamed so far follows the durable head) and goes on tailing.
  const b = await viewer(p);
  expect(await b.client.pending()).toBe(true);
  const turnB = b.client.turn();
  await until(() => b.got.includes('text "look"'));
  gates.look.resolve();
  await until(() => a.got.includes('text "ing"') && b.got.includes('text "ing"'));
  expect(a.got.filter(g => g.startsWith("text"))).toEqual(['text "look"', 'text "ing"']);
  gates.ing.resolve();
  await until(() => a.got.includes("tool t1 echo") && b.got.includes("tool t1 echo"));
  // A third TUI attaches while the tool runs: the streamed text is behind the durable reply (skipped), the running call is ahead of it (shown).
  const c = await viewer(p);
  const turnC = c.client.turn();
  await until(() => c.got.includes("tool t1 echo"));
  expect(c.got.filter(g => g.startsWith("text"))).toEqual([]);
  expect(c.got).toEqual(["tool t1 echo"]); // its transcript was opened at the current head: nothing to re-sync
  gates.tool.resolve();
  await until(() => [a, b, c].every(v => v.got.includes('text "done"')));
  for (const v of [a, b, c]) {
    expect(count(v.got, "end t1 true")).toBe(1);
    expect(v.got.indexOf("end t1 true")).toBeLessThan(v.got.indexOf('text "done"'));
    expect(v.got.indexOf("refresh", v.got.indexOf("end t1 true"))).toBeLessThan(v.got.indexOf('text "done"')); // the results landed before the next reply streamed
  }
  gates.done.resolve();
  await Promise.all([turnA, turnB, turnC]);
  expect(readStatus(p)).toMatchObject({ state: "idle", turns: 1 });
  for (const v of [a, b, c]) {
    for (const item of ['text "look"', 'text "ing"', "tool t1 echo", "end t1 true", 'text "done"']) expect(count(v.got, item)).toBeLessThanOrEqual(1);
    const notices = v.got.filter(g => g.startsWith("notice"));
    expect(notices.every(line => line.startsWith("notice [model request] anthropic/fake-model "))).toBe(true);
    expect(new Set(notices).size).toBe(notices.length); // Each live status is shown at most once.
    expect(v.got.at(-1)).toBe("refresh"); // the final look showed the durable record
    v.client.dispose?.();
  }
  expect(a.client.entries!().filter(e => e.type === "message" && e.message.role === "assistant")).toHaveLength(2);
  await request(p, { kind: "stop" });
  expect(await daemon).toBe("stopped");
  await release!();
  session.dispose?.();
});
