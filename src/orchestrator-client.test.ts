import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteRequest } from "./providers/index";
import { publishLaunch } from "./cancellation";
import { paths, saveConfig } from "./config";
import { createOrchestrator } from "./orchestrator";
import { readStatus, request } from "./orchestrator-channel";
import { createClientOrchestrator, daemonKeeper, ensureDaemon, stopDaemon } from "./orchestrator-client";
import { runDaemon } from "./orchestrator-daemon";
import { saveProjectModel } from "./project-model";
import type { Runner, StartOptions } from "./runner";
import { tryStorageLock } from "./storage-lock";
import { fakeProvider, text } from "./test/fake-provider";
import { open } from "./transcript";

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
  // A cancel while idle pauses and is acknowledged under its token.
  client.cancel!();
  await until(() => notices.some(t => t.includes("nothing was running")));
  expect(existsSync(`${paths.transcript(p, "orchestrator")}.cancel`)).toBe(false);
  await until(() => readStatus(p)?.state === "idle");
  await client.clear!();
  expect(client.entries!().at(-1)?.type).toBe("context-boundary");
  expect(provider.calls).toHaveLength(1); // the client never called the model; the compaction request had nothing to do
  client.dispose?.();
  await request(p, { kind: "stop" });
  expect(await daemon).toBe("stopped");
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
  expect(await keep("k")).toBe("orchestrator started");
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
