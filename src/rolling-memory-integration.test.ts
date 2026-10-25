import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type AgentDeps } from "./agent";
import { paths, saveConfig } from "./config";
import { pending, put } from "./inbox";
import { queryHistory } from "./memory-archive";
import { createOrchestrator, type Orchestrator } from "./orchestrator";
import { RollingCompactor } from "./rolling-memory";
import type { CompleteRequest, Provider } from "./providers";
import { fakeProvider, text } from "./test/fake-provider";
import { open, type Transcript } from "./transcript";
import { disk } from "./transcript-storage";
import { advanceInputEpoch } from "./user-input";

const previous = process.env.ORCA_HOME;
const dirs: string[] = [], sessions: Orchestrator[] = [], controllers: RollingCompactor[] = [], gates: (() => void)[] = [];
afterEach(() => {
  sessions.splice(0).forEach(o => o.dispose?.());
  controllers.splice(0).forEach(c => c.dispose());
  gates.splice(0).forEach(release => release());
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
function gate() {
  const result = Promise.withResolvers<void>(); gates.push(result.resolve); return result;
}
function summary() {
  const entered = gate(), released = gate(), calls: CompleteRequest[] = [];
  const provider: Provider = { name: "openai", models: async () => [], complete: async req => {
    calls.push(req); entered.resolve(); await released.promise;
    return { content: [text(JSON.stringify({ user: [], project: ["Use Bun"], pending: [], tasks: [] }))], stop: "end", completion: "completed" };
  } };
  return { provider, calls, entered, released };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rolling-integration-")); dirs.push(dir); process.env.ORCA_HOME = dir;
  const project = "p", transcript = open(paths.transcript(project, "orchestrator"));
  await saveConfig({ model: "gpt-6-sol" });
  for (const [role, content] of [["user", "old-original-evidence ".repeat(3000)], ["assistant", "older findings ".repeat(2500)], ["user", "recent question"], ["assistant", "recent answer"]] as const) {
    await transcript.append({ type: "message", message: { role, content } });
  }
  const foreground = fakeProvider(Array.from({ length: 5 }, (_, i) => [text(`answer ${i}`)]));
  async function session(worker: ReturnType<typeof summary>, extra = {}) {
    const orch = await createOrchestrator({ project, provider: foreground, tools: {}, write() {},
      rolling: { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => worker.provider }, ...extra });
    sessions.push(orch); return orch;
  }
  const deps: AgentDeps = { model: "gpt-6-sol", provider: foreground, tools: {}, transcript, ctx: { project, role: "orchestrator", cwd: dir }, write() {} };
  function controller(worker: ReturnType<typeof summary>, t = transcript) {
    const rolling = new RollingCompactor(project, t, { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => worker.provider });
    controllers.push(rolling); return rolling;
  }
  return { project, transcript, foreground, session, deps, controller };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await Bun.sleep(1); }
  throw new Error("test condition did not settle");
}

test("refresh/idle checkpoint keeps exact cross-window receipts and newer input; residue cannot run a model", async () => {
  const { project, transcript, foreground, session } = await fixture(), worker = summary();
  const sender = await session(worker), receiver = await session(worker, { rolling: { triggerTokens: 1e9, tailTokens: 20000, loadProvider: async () => worker.provider } });
  await sender.say("same", undefined, "one"); await sender.turn(); await worker.entered.promise;
  await sender.say("same", undefined, "two"); await receiver.turn();
  const history = receiver.entries!();
  worker.released.resolve(); await Bun.sleep(2);
  await sender.refresh!(); await sender.refresh!();
  expect(sender.consumed!()).toEqual(new Set(["one", "two"]));
  expect(sender.entries!()).toEqual(history);
  expect(foreground.calls).toHaveLength(2); expect(worker.calls).toHaveLength(1);
  expect(open(transcript.path).branch()[0]?.type).toBe("message"); // refresh is read-only
  await until(() => sender.pending()); await sender.turn();
  const compacted = open(transcript.path);
  expect(compacted.branch()[0]?.type).toBe("summary");
  expect(compacted.history!()).toEqual(history);
  expect(JSON.stringify(await compacted.chain())).toContain("answer 1");
  expect(compacted.consumed!().inputs).toEqual(new Set(["one", "two"]));
  await put(project, "orchestrator", { from: "user", text: "same", inputId: "two" });
  await receiver.turn();
  expect(await pending(project, "orchestrator")).toBe(false);
  expect(foreground.calls).toHaveLength(2); expect(worker.calls).toHaveLength(1);
  await receiver.say("next", undefined, "three"); await receiver.turn();
  expect(JSON.stringify(foreground.calls[2]!.messages)).toContain("Rolling conversation memory");
  expect(JSON.stringify(foreground.calls[2]!.messages)).not.toContain("old-original-evidence");
  const found = JSON.parse(await queryHistory(project, { action: "search_history", query: "old original evidence" }));
  expect(found.entries).toHaveLength(1);
});

test("external clear invalidates background work on refresh, preserves full replay, and starts no model", async () => {
  const { project, transcript, foreground, session } = await fixture(), worker = summary();
  const a = await session(worker), b = await session(worker);
  await a.say("start", undefined, "before-clear"); await a.turn(); await worker.entered.promise;
  const before = a.entries!();
  await b.clear!(); await a.refresh!();
  expect(worker.calls[0]!.signal!.aborted).toBe(true);
  worker.released.resolve(); await Bun.sleep(2);
  expect(await a.pending()).toBe(false); await a.turn();
  expect(await open(transcript.path).chain()).toEqual([]);
  expect(a.entries!().slice(0, before.length)).toEqual(before);
  expect(a.consumed!()).toEqual(new Set(["before-clear"]));
  expect(worker.calls).toHaveLength(1); expect(foreground.calls).toHaveLength(1);
  expect(JSON.parse(await queryHistory(project, { action: "search_history", query: "old original evidence" })).entries).toEqual([]);
  await a.say("fresh", undefined, "after-clear"); await a.turn();
  expect(JSON.stringify(foreground.calls[1]!.messages)).not.toContain("old-original-evidence");
  expect(JSON.stringify(foreground.calls[1]!.messages)).not.toContain("Rolling conversation memory");
  expect(a.consumed!()).toEqual(new Set(["before-clear", "after-clear"]));
});

test("another session's cancellation invalidates old summaries even when fresh input resumes before refresh", async () => {
  const { transcript, foreground, session } = await fixture(), worker = summary();
  const a = await session(worker), b = await session(worker);
  await a.say("start"); await a.turn(); await worker.entered.promise;
  b.cancel!(); await b.say("fresh resume", undefined, "resume");
  await a.refresh!();
  expect(worker.calls[0]!.signal!.aborted).toBe(true);
  worker.released.resolve(); await Bun.sleep(2);
  expect(open(transcript.path).branch()[0]?.type).toBe("message");
  expect(foreground.calls).toHaveLength(1); expect(worker.calls).toHaveLength(1);
  await a.turn();
  expect(foreground.calls).toHaveLength(2);
  expect(a.consumed!().has("resume")).toBe(true);
  expect(worker.calls).toHaveLength(2); // fresh input, not refresh, authorized the new worker
  expect(worker.calls[1]!.signal!.aborted).toBe(false);
});

test("competing background summaries discard the stale checkpoint without losing receipts or restarting inference", async () => {
  const { transcript, foreground, session } = await fixture(), first = summary(), second = summary();
  const a = await session(first), b = await session(second);
  await a.say("first", undefined, "first"); await a.turn(); await first.entered.promise;
  await b.say("second", undefined, "second"); await b.turn(); await second.entered.promise;
  first.released.resolve(); second.released.resolve();
  await until(() => a.pending()); await a.turn();
  const bytes = await Bun.file(transcript.path).text();
  await b.refresh!(); expect(await b.pending()).toBe(false); await b.turn();
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
  expect(first.calls).toHaveLength(1); expect(second.calls).toHaveLength(1); expect(foreground.calls).toHaveLength(2);
  expect(b.consumed!()).toEqual(new Set(["first", "second"]));
  expect(open(transcript.path).all!().filter(e => e.type === "summary")).toHaveLength(1);
});

test("a writer racing checkpoint append is rejected under the publication lock, not hidden by a stale retained tail", async () => {
  const { transcript, deps, controller } = await fixture(), worker = summary(), entered = gate(), released = gate();
  const wrapped: Transcript = { ...transcript, append: async (entry, signal, guard) => {
    if (entry.type === "summary") { entered.resolve(); await released.promise; }
    return transcript.append(entry, signal, guard);
  } };
  const rolling = controller(worker, wrapped);
  await rolling.boundary({ ...deps, transcript: wrapped }); await worker.entered.promise;
  worker.released.resolve(); await until(() => rolling.ready());
  const applying = rolling.boundary({ ...deps, transcript: wrapped }, false, true); await entered.promise;
  const external = open(transcript.path);
  await external.append({ type: "message", inbox: [{ from: "user", text: "external", ts: new Date().toISOString(), inputId: "external", deliveryId: "orchestrator/external.json" }], message: { role: "user", content: "external newest message" } });
  const bytes = await Bun.file(transcript.path).text(); released.resolve(); await applying;
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
  expect(open(transcript.path).branch()[0]?.type).toBe("message");
  expect(open(transcript.path).consumed!().inputs).toEqual(new Set(["external"]));
  expect((await open(transcript.path).chain()).at(-1)?.content).toBe("external newest message");
});

for (const cancel of ["local", "shared"] as const) test(`${cancel} cancellation during checkpoint staging vetoes publication`, async () => {
  const { project, transcript, deps, controller } = await fixture(), worker = summary(), entered = gate(), released = gate();
  let block = false;
  const staged = open(transcript.path, { ...disk, open: async (path, flags) => {
    const file = await disk.open(path, flags);
    return { write: bytes => file.write(bytes), close: () => file.close(), sync: async () => {
      await file.sync(); if (block && flags === "wx") { entered.resolve(); await released.promise; }
    } };
  } });
  const rolling = controller(worker, staged), current = { ...deps, transcript: staged };
  await rolling.boundary(current); await worker.entered.promise; worker.released.resolve(); await until(() => rolling.ready());
  const bytes = await Bun.file(transcript.path).text(); block = true;
  const applying = rolling.boundary(current, false, true); await entered.promise;
  if (cancel === "local") rolling.reset(); else advanceInputEpoch(project);
  released.resolve(); await applying;
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
  expect(open(transcript.path).branch()[0]?.type).toBe("message");
});

test("reset during asynchronous archive preparation prevents a late worker from starting", async () => {
  const { transcript, deps, controller } = await fixture(), worker = summary();
  let rolling: RollingCompactor;
  const wrapped: Transcript = { ...transcript, all: () => { rolling.reset(); return transcript.all!(); } };
  rolling = controller(worker, wrapped);
  await rolling.boundary({ ...deps, transcript: wrapped });
  expect(worker.calls).toHaveLength(0); expect(rolling.ready()).toBe(false);
});

test("idle maintenance never starts a new summary even for oversized refreshed history", async () => {
  const { deps, controller } = await fixture(), worker = summary(), rolling = controller(worker);
  await rolling.boundary(deps, false, true);
  expect(worker.calls).toHaveLength(0); expect(rolling.ready()).toBe(false);
});

test("one-shot CLI shares whole-turn ownership while joining memory; residue and passive refresh never resume history", async () => {
  const { project, transcript, foreground, session } = await fixture(), worker = summary();
  const other = await session(worker);
  await other.say("cli", undefined, "cli");
  const run = runAgent({ project, role: "orchestrator", loadProvider: async () => foreground,
    rolling: { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => worker.provider } });
  await worker.entered.promise; await until(() => foreground.calls.length === 1);
  await other.say("queued", undefined, "queued");
  await other.turn(); await other.refresh!();
  expect(foreground.calls).toHaveLength(1);
  await expect(other.clear!()).rejects.toThrow("another session");
  worker.released.resolve(); expect(await run).toBe(0);
  await other.turn();
  expect(other.consumed!()).toEqual(new Set(["cli", "queued"]));
  expect(foreground.calls.length).toBeGreaterThanOrEqual(2);
  const count = foreground.calls.length, summaryCount = worker.calls.length;
  await put(project, "orchestrator", { from: "user", text: "cli", inputId: "cli" });
  expect(await runAgent({ project, role: "orchestrator", loadProvider: async () => foreground, rolling: { loadProvider: async () => worker.provider } })).toBe(0);
  expect(foreground.calls).toHaveLength(count); expect(worker.calls).toHaveLength(summaryCount);
  expect(await pending(project, "orchestrator")).toBe(false);
  expect(open(transcript.path).consumed!().inputs).toEqual(new Set(["cli", "queued"]));
});

test("one-shot CLI cannot resume a paused project with old input", async () => {
  const { project, foreground, session } = await fixture(), worker = summary(), other = await session(worker);
  await other.say("old", undefined, "old"); other.cancel!();
  expect(await runAgent({ project, role: "orchestrator", loadProvider: async () => foreground, rolling: { loadProvider: async () => worker.provider } })).toBe(0);
  expect(foreground.calls).toHaveLength(0); expect(worker.calls).toHaveLength(0);
  expect(await pending(project, "orchestrator")).toBe(true);
});

test("failed checkpoint publication keeps committed prompts/receipts without resending or acknowledging new queued input", async () => {
  const { project, transcript, foreground, session } = await fixture(), worker = summary();
  let fail = false;
  const storage = open(transcript.path, { ...disk, rename: (from, to) => fail ? Promise.reject(new Error("checkpoint write failed")) : disk.rename(from, to) });
  const seen: string[] = [];
  const a = await session(worker, { transcript: storage, onInbox: (messages: { inputId?: string }[]) => seen.push(...messages.map(m => m.inputId!)) });
  await a.say("committed", undefined, "committed"); await a.turn(); await worker.entered.promise;
  const bytes = await Bun.file(transcript.path).text();
  worker.released.resolve(); await until(() => a.pending()); fail = true;
  await a.turn();
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
  expect(a.consumed!()).toEqual(new Set(["committed"])); expect(seen).toEqual(["committed"]);
  await a.say("queued", undefined, "queued");
  await expect(a.clear!()).rejects.toThrow("input is pending");
  await a.refresh!();
  expect(a.consumed!().has("queued")).toBe(false); expect(await pending(project, "orchestrator")).toBe(true);
  expect(foreground.calls).toHaveLength(1);
  fail = false; await a.turn();
  expect(a.consumed!()).toEqual(new Set(["committed", "queued"])); expect(seen).toEqual(["committed", "queued"]);
  expect(foreground.calls).toHaveLength(2);
});

test("history retrieval waits for a concurrent clear's project-state transaction and uses its new scope", async () => {
  const { project, transcript, session } = await fixture(), worker = summary(), entered = gate(), released = gate();
  const wrapped: Transcript = { ...transcript, append: async (entry, signal, guard) => {
    if (entry.type === "context-boundary") { entered.resolve(); await released.promise; }
    return transcript.append(entry, signal, guard);
  } };
  const orch = await session(worker, { transcript: wrapped });
  const clearing = orch.clear!(); await entered.promise;
  let read = false;
  const query = queryHistory(project, { action: "search_history", query: "old original evidence" }).then(value => { read = true; return JSON.parse(value); });
  await Bun.sleep(2); expect(read).toBe(false);
  released.resolve(); await clearing;
  expect((await query).entries).toEqual([]); expect(worker.calls).toHaveLength(0);
});
