import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config/config";
import { createOrchestrator } from "./orchestrator";
import { consume, drain, format, pending, put } from "../../data/inbox/inbox";
import { open } from "../../data/transcripts/transcript";
import { disk } from "../../data/transcripts/transcript-storage";
import { fakeProvider, text, toolUse } from "../../../test/fake-provider";
import { inputEpoch } from "../../data/inbox/user-input";

let home: string;
const previous = process.env.ORCA_HOME;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "session-refresh-"));
  process.env.ORCA_HOME = home;
  await Bun.write(paths.config, 'model = "fake-model"\n');
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

// All providers/tools are local fakes. Child processes inherit only the temp home.
test("another window acknowledges exact committed input IDs, not identical text; refresh never requests a model", async () => {
  const project = "shared", provider = fakeProvider([[text("done")]]);
  const sender = await createOrchestrator({ project, provider, tools: {}, write() {} });
  const receiver = await createOrchestrator({ project, provider, tools: {}, write() {} });
  await sender.say("same", undefined, "one");
  await receiver.turn();
  await sender.say("same", undefined, "two");
  expect(sender.consumed!().has("one")).toBe(false);
  const epoch = inputEpoch(project);
  await sender.refresh!();
  expect(sender.consumed!()).toEqual(new Set(["one"]));
  expect(provider.calls).toHaveLength(1);
  expect(await pending(project, "orchestrator")).toBe(true);
  expect(inputEpoch(project)).toBe(epoch);
  expect(JSON.stringify(sender.entries!())).toContain("done");
  // A file disappearing is not a receipt, nor is a legacy entry with the same text.
  await drain(project, "orchestrator");
  await open(paths.transcript(project, "orchestrator")).append({ type: "message", message: { role: "user", content: "[user] same" } });
  await sender.refresh!();
  expect(sender.consumed!()).toEqual(new Set(["one"]));
});

test("overlapping windows own one whole turn; input submitted while busy is consumed in order, and next turn sees shared context", async () => {
  const started = deferred(), release = deferred();
  const provider = fakeProvider([[toolUse("hold", "hold", {})], [text("done")], [text("next")]]);
  const opts = { project: "turn", provider, write() {}, tools: { hold: {
    spec: { name: "hold", input_schema: { type: "object" as const } },
    async run() { started.resolve(); await release.promise; return "ok"; },
  } } };
  const a = await createOrchestrator(opts), b = await createOrchestrator(opts);
  await a.say("first", undefined, "first");
  const running = a.turn();
  await started.promise;
  const before = a.entries!();
  expect(await a.refresh!()).toBe(false);
  expect(a.entries!()).toEqual(before);
  await expect(b.clear!()).rejects.toThrow("another session");
  await b.say("second", undefined, "second");
  await b.say("third", undefined, "third");
  await b.turn(); // nonblocking: cannot create a second consumer/model loop
  expect(provider.calls).toHaveLength(1);
  release.resolve(); await running;
  expect(provider.calls).toHaveLength(2);
  expect(JSON.stringify(provider.calls[1]!.messages)).toContain("[user] second\\n\\n[user] third");
  await b.say("next", undefined, "next"); await b.turn();
  const context = JSON.stringify(provider.calls[2]!.messages);
  expect(context).toContain("first"); expect(context).toContain("second"); expect(context).toContain("done");
  await a.refresh!();
  expect(a.consumed!()).toEqual(new Set(["first", "second", "third", "next"]));
  expect(await a.pending()).toBe(false);
});

test("failed context append keeps inbox retryable and never notifies consumption; failed refresh leaves context intact", async () => {
  let failRead = false, failWrite = false;
  const t = open(paths.transcript("failure", "orchestrator"), { ...disk,
    read: path => failRead ? Promise.reject(Error("read failed")) : disk.read(path),
    rename: (a, b) => failWrite ? Promise.reject(Error("write failed")) : disk.rename(a, b),
  });
  const provider = fakeProvider([[text("ok")]]), seen: string[] = [];
  const orch = await createOrchestrator({ project: "failure", transcript: t, provider, tools: {}, write() {}, onInbox: ms => seen.push(...ms.map(m => m.inputId!)) });
  await orch.say("retained", undefined, "id");
  const head = t.head();
  failWrite = true;
  await expect(orch.turn()).rejects.toThrow("write failed");
  expect(await pending("failure", "orchestrator")).toBe(true);
  expect(t.head()).toBe(head); expect(seen).toEqual([]); expect(provider.calls).toHaveLength(0);
  failWrite = false; failRead = true;
  await expect(orch.refresh!()).rejects.toThrow("read failed");
  expect(t.head()).toBe(head);
  // Publication of new input is independent of a failed refresh.
  await orch.say("also retained", undefined, "id2");
  failRead = false;
  await orch.turn();
  expect(seen).toEqual(["id", "id2"]);
  expect(provider.calls).toHaveLength(1);
});

test("postcommit crash/cleanup residue and duplicate ID files cannot resend consumed input, even after clear/compaction", async () => {
  const project = "residue", t = open(paths.transcript(project, "orchestrator"));
  await put(project, "orchestrator", { from: "user", text: "once", inputId: "once" });
  const name = readdirSync(join(paths.inbox(project), "orchestrator")).find(n => n.endsWith(".json"))!;
  const msg = await Bun.file(join(paths.inbox(project), "orchestrator", name)).json();
  // Exact crash boundary: transcript rename happened, inbox unlink did not.
  await t.append({ type: "message", inbox: [{ ...msg, deliveryId: `orchestrator/${name}` }], message: { role: "user", content: "[user] once" } });
  await t.append({ type: "summary", text: "summary", retained: [] });
  await t.append({ type: "context-boundary" });
  await put(project, "orchestrator", { from: "user", text: "once", inputId: "once" });
  const provider = fakeProvider([]), orch = await createOrchestrator({ project, provider, tools: {}, write() {} });
  await orch.turn();
  expect(provider.calls).toHaveLength(0);
  expect(await pending(project, "orchestrator")).toBe(false);
  expect(orch.consumed!()).toEqual(new Set(["once"]));
  expect(await t.chain()).toEqual([]);
});

test("provider failure is consumed context, never an automatic retry; a fresh prompt uses that retained context", async () => {
  const provider = fakeProvider([]), project = "provider-error";
  const a = await createOrchestrator({ project, provider, tools: {}, write() {} });
  const b = await createOrchestrator({ project, provider, tools: {}, write() {} });
  await a.say("already consumed", undefined, "id");
  await expect(a.turn()).rejects.toThrow("script exhausted");
  await b.refresh!();
  expect(b.consumed!()).toEqual(new Set(["id"]));
  expect(await b.pending()).toBe(false); await b.turn();
  expect(provider.calls).toHaveLength(1);
  await b.say("new authorization");
  await expect(b.turn()).rejects.toThrow("script exhausted");
  expect(provider.calls).toHaveLength(2);
  expect(JSON.stringify(provider.calls[1]!.messages)).toContain("already consumed");
});

test("shared cancellation epoch survives refresh and other windows; only new input/explicit compaction resumes", async () => {
  const provider = fakeProvider([[text("fresh")]]), project = "paused";
  const a = await createOrchestrator({ project, provider, tools: {}, write() {} });
  const b = await createOrchestrator({ project, provider, tools: {}, write() {} });
  const old = a.submission!(); a.cancel!();
  await a.say("pre-cancel input published late", old, "old");
  await put(project, "orchestrator", { from: "worker-other", text: "report" });
  await b.refresh!();
  expect(await b.pending()).toBe(false); await b.turn();
  expect(provider.calls).toHaveLength(0);
  await b.say("new input", b.submission!(), "fresh");
  expect(await b.pending()).toBe(true); await b.turn();
  await a.refresh!();
  expect(a.consumed!()).toEqual(new Set(["old", "fresh"]));
  await put(project, "orchestrator", { from: "worker-other", text: "now allowed" });
  expect(await a.pending()).toBe(true);
});

test("concurrent transcript handles refresh and append under one publication lock, preserving byte prefix and parent history", async () => {
  const path = join(home, "t.jsonl"), a = open(path), b = open(path);
  await Bun.write(path, "damaged legacy bytes\n");
  await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).append({ type: "message", message: { role: "user", content: `entry ${i}` } })));
  await Promise.all([a.refresh!(), b.refresh!()]);
  expect((await Bun.file(path).text()).startsWith("damaged legacy bytes\n")).toBe(true);
  expect(await a.chain()).toHaveLength(24);
  expect(await a.chain()).toEqual(await b.chain());
  expect(a.history!()).toHaveLength(24);
});

test("separate Bun processes serialize transcript publications and inbox consumption", async () => {
  const project = "process", path = paths.transcript(project, "orchestrator");
  mkdirSync(paths.project(project), { recursive: true });
  for (let i = 0; i < 12; i++) await put(project, "orchestrator", { from: "user", text: `message ${i}`, inputId: `${i}` });
  const code = `import { open } from ${JSON.stringify(join(import.meta.dir, "../../data/transcripts/transcript.ts"))};
    import { consume, format } from ${JSON.stringify(join(import.meta.dir, "../../data/inbox/inbox.ts"))};
    const t = open(${JSON.stringify(path)});
    await consume(${JSON.stringify(project)}, "orchestrator", t, inbox => t.append({type:"message", inbox, message:{role:"user",content:format(inbox)}}));
    for(let i=0;i<8;i++) await t.append({type:"message", message:{role:"assistant",content:process.pid+":"+i}});`;
  const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "--eval", code], { env: { ...process.env, ORCA_HOME: home }, stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(p => p.exited))).toEqual([0, 0, 0]);
  const t = open(path);
  expect(t.history!()).toHaveLength(25);
  expect(t.consumed!().inputs.size).toBe(12);
  expect(await pending(project, "orchestrator")).toBe(false);
});

test("concurrent legacy drains claim one batch; transactional consumption notifies only after disk commit", async () => {
  await put("drain", "orchestrator", { from: "user", text: "once" });
  const batches = await Promise.all([drain("drain", "orchestrator"), drain("drain", "orchestrator")]);
  expect(batches.flat()).toHaveLength(1);
  const t = open(paths.transcript("consume", "orchestrator"));
  await put("consume", "orchestrator", { from: "user", text: "safe", inputId: "safe" });
  await consume("consume", "orchestrator", t, inbox => t.append({ type: "message", inbox, message: { role: "user", content: format(inbox) } }));
  expect(open(t.path).consumed!().inputs).toEqual(new Set(["safe"]));
});


test("invalid inbox records fail closed and distinct files with one inputId commit only once", async () => {
  const project = "invalid", t = open(paths.transcript(project, "orchestrator"));
  await put(project, "orchestrator", { from: "user", text: "kept", inputId: "same-id" });
  await put(project, "orchestrator", { from: "user", text: "kept", inputId: "same-id" });
  const bad = join(paths.inbox(project), "orchestrator", "invalid.json");
  await Bun.write(bad, "not JSON");
  let commits = 0;
  const commit = async (inbox: Parameters<Parameters<typeof consume>[3]>[0]) => {
    commits++;
    await t.append({ type: "message", inbox, message: { role: "user", content: format(inbox) } });
  };
  await expect(consume(project, "orchestrator", t, commit)).rejects.toThrow();
  expect(commits).toBe(0); expect(t.head()).toBeNull();
  expect(readdirSync(join(paths.inbox(project), "orchestrator")).filter(n => n.endsWith(".json"))).toHaveLength(3);
  rmSync(bad);
  const consumed = await consume(project, "orchestrator", t, commit);
  expect(consumed).toHaveLength(1); expect(commits).toBe(1);
  expect(t.consumed!().inputs).toEqual(new Set(["same-id"]));
  expect(await pending(project, "orchestrator")).toBe(false);
});


test("explicit compaction preserves local resume permission across refresh but a later shared cancel revokes it", async () => {
  const project = "compact-resume", provider = fakeProvider([[text("report received")]]);
  const a = await createOrchestrator({ project, provider, tools: {}, write() {} });
  const b = await createOrchestrator({ project, provider, tools: {}, write() {} });
  a.cancel!();
  await a.compact!(); await a.turn(); // empty history: no summary/model request
  await put(project, "orchestrator", { from: "worker-existing", text: "report" });
  await a.refresh!();
  expect(await a.pending()).toBe(true);
  expect(await b.pending()).toBe(false); // local explicit compact isn't a fresh human inbox message
  await a.turn();
  expect(provider.calls).toHaveLength(1);
  await a.compact!(); // this request also predates the other window's cancel
  b.cancel!();
  await put(project, "orchestrator", { from: "worker-existing", text: "later report" });
  await a.refresh!();
  expect(await a.pending()).toBe(false); await a.turn();
  expect(provider.calls).toHaveLength(1);
});
