import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { createAgent, type AgentDeps } from "./agent";
import { paths, saveConfig } from "./config";
import { estimate } from "./compaction";
import { forwardImages } from "./image-handoff";
import { historicalMessages } from "./image-history";
import { blockRef, imageContent, loadImage, pendingImageInputs, saveImage, saveImageInput, type ImageRef } from "./images";
import { content, consume, pending, put } from "./inbox";
import { archivePath, entryText, queryHistory } from "./memory-archive";
import { createOrchestrator, type Orchestrator } from "./orchestrator";
import { claudeMessages } from "./providers/anthropic";
import { toResponses } from "./providers/openai";
import type { CompleteRequest, Provider } from "./providers";
import { RollingCompactor } from "./rolling-memory";
import { summarizeOlder } from "./rolling-summary";
import { fakeProvider, text, toolUse } from "./test/fake-provider";
import { png } from "./test/image-fixture";
import { open, type Transcript } from "./transcript";
import { disk } from "./transcript-storage";
import { message } from "./tools/message";
import { orchestratorTask } from "./tools/task";

const before = process.env.PARALLELS_HOME;
const dirs: string[] = [], sessions: Orchestrator[] = [], controllers: RollingCompactor[] = [];
afterEach(() => {
  sessions.splice(0).forEach(o => o.dispose?.()); controllers.splice(0).forEach(c => c.dispose());
  if (before === undefined) delete process.env.PARALLELS_HOME; else process.env.PARALLELS_HOME = before;
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
const memory = { user: [], project: ["Retain visual requirements; pixels are separate."], pending: [], tasks: [] };
function summary(gated = false) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), calls: CompleteRequest[] = [];
  if (!gated) release.resolve();
  const provider: Provider = { name: "openai", models: async () => [], complete: async req => {
    calls.push(req); entered.resolve(); await release.promise;
    return { content: [text(JSON.stringify(memory))], stop: "end", completion: "completed" };
  } };
  return { provider, calls, entered, release };
}
async function fixture(model = "claude-sonnet-4-6") {
  const dir = mkdtempSync(join(tmpdir(), "rolling-images-")); dirs.push(dir); process.env.PARALLELS_HOME = dir;
  await saveConfig({ model });
  const project = "p", transcript = open(paths.transcript(project, "orchestrator"));
  const refs = [await saveImage(project, png()), await saveImage(project, png(2, 1, 250))];
  const ctx = { project, role: "orchestrator" as const, cwd: dir };
  return { project, transcript, refs, ctx, model };
}
function ids(messages: MessageParam[]) {
  return messages.flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => b.type === "image" ? [blockRef(b)!.id] : []));
}
function pixels(messages: MessageParam[]) {
  return messages.flatMap(m => typeof m.content === "string" ? [] : m.content.flatMap(b => b.type === "image" && b.source.type === "base64" ? [b.source.data] : []));
}
async function commit(project: string, t: Transcript, refs: ImageRef[], prompt = "same visual brief ".repeat(2000)) {
  const inputId = crypto.randomUUID();
  await saveImageInput(project, { inputId, text: prompt, attachments: refs });
  await put(project, "orchestrator", { from: "user", text: prompt, inputId, attachments: refs });
  await consume(project, "orchestrator", t, async inbox => {
    await t.append({ type: "message", inbox, message: { role: "user", content: content(inbox) } });
  });
  return inputId;
}
async function tail(t: Transcript) {
  await t.append({ type: "message", message: { role: "assistant", content: "older findings ".repeat(2000) } });
  await t.append({ type: "message", message: { role: "user", content: "recent question" } });
  await t.append({ type: "message", message: { role: "assistant", content: "recent answer" } });
}
function controller(f: Awaited<ReturnType<typeof fixture>>, worker: ReturnType<typeof summary>, transcript = f.transcript) {
  const rolling = new RollingCompactor(f.project, transcript, { triggerTokens: 5000, tailTokens: 200, loadProvider: async () => worker.provider });
  controllers.push(rolling);
  const foreground = fakeProvider([[text("inspected")]]);
  const deps: AgentDeps = { model: f.model, transcript, tools: {}, provider: foreground, ctx: f.ctx, compaction: {}, write() {} };
  return { rolling, deps, foreground };
}

for (const model of ["claude-sonnet-4-6", "gpt-5.5"]) test(`${model}: queue -> rolling checkpoints/SQLite -> refresh/provider pixels -> explicit worker handoff`, async () => {
  const f = await fixture(model), worker = summary(), foreground = fakeProvider(Array.from({ length: 8 }, () => [text("inspected")]));
  const orch = await createOrchestrator({ project: f.project, transcript: f.transcript, provider: foreground, tools: {}, write() {},
    rolling: { triggerTokens: 1e9, tailTokens: 200, loadProvider: async () => worker.provider } });
  sessions.push(orch);
  const inputId = crypto.randomUUID();
  await orch.say("visual-original-evidence ".repeat(1600), undefined, inputId, f.refs); await orch.turn();
  await orch.say("recent question"); await orch.turn();
  const history = orch.entries!(), original = history.find(e => e.type === "message" && e.inbox?.some(m => m.inputId === inputId))!;
  for (let round = 0; round < 2; round++) {
    if (round) { await orch.say("follow-up prose ".repeat(2000)); await orch.turn(); }
    await orch.compact!(); await orch.turn();
    expect(f.transcript.branch()[0]?.type).toBe("summary");
    expect(ids(await f.transcript.chain())).toEqual(f.refs.map(r => r.id));
    expect(f.transcript.history!().slice(0, history.length)).toEqual(history);
    expect(orch.consumed!().has(inputId)).toBe(true);
  }
  expect(worker.calls).toHaveLength(2);
  for (const request of worker.calls) {
    const source = JSON.stringify(request.messages);
    expect(source).toContain(f.refs[0]!.id); expect(source).toContain("not inspected");
    expect(source).not.toContain("parallels-image:"); expect(source).not.toContain(png().toString("base64"));
    expect(pixels(request.messages)).toEqual([]);
  }
  const rows = JSON.parse(await queryHistory(f.project, { action: "search_history", query: f.refs[0]!.id }));
  expect(rows.entries.some((e: { entryId: string }) => e.entryId === original.uuid)).toBe(true);
  const page = JSON.parse(await orchestratorTask.run({ action: "read_history", entryId: original.uuid, offset: entryText(original).indexOf("[Historical image") }, f.ctx));
  expect(page.text).toContain(`attachment_id=${f.refs[0]!.id}`);
  expect(page.text).not.toContain("parallels-image:"); expect(page.text).not.toContain("base64");
  const db = new Database(archivePath(), { readonly: true });
  try {
    const row = db.query("SELECT raw,body FROM entries WHERE id=?").get(original.uuid) as { raw: string; body: string };
    expect(JSON.parse(row.raw)).toEqual(original); expect(row.raw).toContain("parallels-image:");
    expect(row.body).not.toContain("parallels-image:"); expect(row.body).toContain(f.refs[0]!.id);
  } finally { db.close(); }
  const refreshed = await createOrchestrator({ project: f.project, provider: foreground, tools: {}, write() {}, rolling: { triggerTokens: 1e9, loadProvider: async () => worker.provider } });
  sessions.push(refreshed); await refreshed.refresh!();
  const calls = foreground.calls.length;
  await put(f.project, "orchestrator", { from: "user", text: "identical retry", inputId, attachments: f.refs });
  await refreshed.turn(); expect(foreground.calls).toHaveLength(calls); expect(await pending(f.project, "orchestrator")).toBe(false);
  await refreshed.say("inspect these again"); await refreshed.turn();
  const delivered = foreground.calls.at(-1)!.messages, expected = [png(), png(2, 1, 250)].map(b => b.toString("base64"));
  expect(pixels(delivered)).toEqual(expected); expect(pixels(claudeMessages(delivered))).toEqual(expected);
  const urls = (toResponses(delivered) as any[]).flatMap(m => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "input_image").map((b: any) => b.image_url) : []);
  expect(urls).toEqual(expected.map(b => `data:image/png;base64,${b}`));
  expect(await forwardImages([f.refs[1]!.id], f.ctx)).toEqual([f.refs[1]!]);
  expect(await message.run({ to: "worker-visual", text: "implement this specific image", attachments: [f.refs[1]!.id] }, f.ctx)).toContain("sent to");
  const agentProvider = fakeProvider([[text("worker saw it")]]), agentTranscript = open(paths.transcript(f.project, "worker-visual"));
  await createAgent({ transcript: agentTranscript, provider: agentProvider, tools: {}, model, ctx: { ...f.ctx, role: "worker", branch: "visual" }, write() {} }).run();
  expect(pixels(agentProvider.calls[0]!.messages)).toEqual([expected[1]!]);
  await expect(forwardImages([f.refs[0]!.id], { ...f.ctx, role: "worker", branch: "visual" })).rejects.toThrow("not received");
  await refreshed.clear!();
  expect(await open(f.transcript.path).chain()).toEqual([]); expect(refreshed.consumed!().has(inputId)).toBe(true);
  expect(await pendingImageInputs(f.project, refreshed.consumed!())).toEqual([]);
  await expect(forwardImages([f.refs[0]!.id], f.ctx)).rejects.toThrow("not received");
  await expect(queryHistory(f.project, { action: "read_history", entryId: original.uuid })).rejects.toThrow("current context scope");
  expect(JSON.parse(await queryHistory(f.project, { action: "search_history", query: f.refs[0]!.id })).entries).toEqual([]);
  expect(await loadImage(f.project, f.refs[0]!)).toEqual(png());
  // Mere historical text can be mentioned/searched in the new scope, but does
  // not reintroduce pixels or grant forwarding permission after a clear.
  await open(f.transcript.path).append({ type: "message", message: { role: "user", content: `old attachment_id=${f.refs[0]!.id}` } });
  expect(JSON.parse(await queryHistory(f.project, { action: "search_history", query: f.refs[0]!.id })).entries).toHaveLength(1);
  await expect(forwardImages([f.refs[0]!.id], f.ctx)).rejects.toThrow("not received");
  expect(ids(await open(f.transcript.path).chain())).toEqual([]);
});

for (const prompt of ["", "same visual brief ".repeat(2000)]) test(`${prompt ? "identical-text/different-ID" : "image-only"} arrival during background summary keeps exact receipts and pixels on both sides of the cut`, async () => {
  const f = await fixture(), worker = summary(true);
  const first = await commit(f.project, f.transcript, [f.refs[0]!]); await tail(f.transcript);
  const { rolling, deps } = controller(f, worker);
  await rolling.boundary(deps); await worker.entered.promise;
  const other = open(f.transcript.path), second = await commit(f.project, other, [f.refs[1]!], prompt);
  worker.release.resolve(); await rolling.finish(); await rolling.boundary(deps, false, true);
  expect(f.transcript.branch()[0]?.type).toBe("summary");
  expect(ids(await f.transcript.chain())).toEqual(f.refs.map(r => r.id));
  expect(f.transcript.consumed!().inputs).toEqual(new Set([first, second]));
  expect((await f.transcript.chain()).at(-1)?.content).toEqual((await other.chain()).at(-1)?.content);
  expect(await pendingImageInputs(f.project, f.transcript.consumed!().inputs)).toEqual([]);
});

for (const action of ["clear", "cancel"] as const) test(`external ${action} vetoes in-flight image memory without erasing receipts/bytes`, async () => {
  const f = await fixture(), worker = summary(true), inputId = await commit(f.project, f.transcript, f.refs); await tail(f.transcript);
  const { rolling, deps } = controller(f, worker);
  await rolling.boundary(deps); await worker.entered.promise;
  const other = await createOrchestrator({ project: f.project, provider: fakeProvider([]), tools: {}, write() {} }); sessions.push(other);
  if (action === "clear") await other.clear!(); else other.cancel!();
  await f.transcript.refresh!(); rolling.reconcile();
  expect(worker.calls[0]!.signal!.aborted).toBe(true);
  worker.release.resolve(); await rolling.finish(); await rolling.boundary(deps, false, true);
  expect(f.transcript.branch().some(e => e.type === "summary")).toBe(false);
  expect(f.transcript.consumed!().inputs).toEqual(new Set([inputId]));
  expect(ids(await f.transcript.chain())).toEqual(action === "clear" ? [] : f.refs.map(r => r.id));
  expect(await loadImage(f.project, f.refs[0]!)).toEqual(png());
  expect(worker.calls).toHaveLength(1);
});

test("failed rolling checkpoint append keeps image context, searchable originals and receipts intact", async () => {
  const f = await fixture(), worker = summary(), inputId = await commit(f.project, f.transcript, f.refs); await tail(f.transcript);
  const bytes = readFileSync(f.transcript.path, "utf8");
  const broken = open(f.transcript.path, { ...disk, rename: async () => { throw new Error("disk full"); } });
  const { rolling, deps } = controller(f, worker, broken);
  await rolling.boundary(deps, true);
  expect(readFileSync(f.transcript.path, "utf8")).toBe(bytes);
  expect(ids(await broken.chain())).toEqual(f.refs.map(r => r.id)); expect(broken.consumed!().inputs).toEqual(new Set([inputId]));
  expect(JSON.parse(await queryHistory(f.project, { action: "search_history", query: f.refs[0]!.id })).entries).toHaveLength(1);
});

test("retained image budget blocks requests rather than dropping pixels; unsupported switching precedes summary inference", async () => {
  const f = await fixture(), worker = summary();
  await commit(f.project, f.transcript, f.refs); await commit(f.project, f.transcript, f.refs); await tail(f.transcript);
  const { rolling, deps, foreground } = controller(f, worker);
  deps.compaction = { contextLimit: 30000, outputReserve: 2000 };
  await expect(createAgent({ ...deps, compactBoundary: (d, m, idle) => rolling.boundary(d, m, idle) }).run()).rejects.toThrow("context blocked");
  expect(worker.calls).toHaveLength(1); expect(foreground.calls).toHaveLength(0);
  expect(ids(await f.transcript.chain())).toEqual([...f.refs, ...f.refs].map(r => r.id));
  expect(estimate(await f.transcript.chain())).toBeGreaterThan(24000);
  await expect(createAgent({ ...deps, model: "unknown-text-model", compactBoundary: (d, m, idle) => rolling.boundary(d, m, idle) }).run()).rejects.toThrow("image input is not enabled");
  expect(worker.calls).toHaveLength(1); expect(foreground.calls).toHaveLength(0);
});

test("missing retained bytes fail at the provider boundary after rolling; committed image prompts are never replayed", async () => {
  const f = await fixture(), worker = summary(), inputId = await commit(f.project, f.transcript, f.refs); await tail(f.transcript);
  const { rolling, deps, foreground } = controller(f, worker); await rolling.boundary(deps, true);
  rmSync(join(paths.project(f.project), "images", `${f.refs[0]!.id}.png`));
  const next = crypto.randomUUID(); await put(f.project, "orchestrator", { from: "user", inputId: next, text: "inspect again" });
  await expect(createAgent({ ...deps, requireInbox: true }).run()).rejects.toThrow();
  expect(foreground.calls).toHaveLength(0); expect(f.transcript.consumed!().inputs).toEqual(new Set([inputId, next]));
  expect(ids(await open(f.transcript.path).chain())).toEqual(f.refs.map(r => r.id));
  await createAgent({ ...deps, requireInbox: true }).run(); expect(foreground.calls).toHaveLength(0);
});

test("text-only memory/search sanitizes inline/nested image bytes and URLs without treating arbitrary tool inputs as blocks", async () => {
  const f = await fixture(), worker = summary();
  const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: png().toString("base64") } };
  const messages: MessageParam[] = [
    { role: "user", content: imageContent("scoped", f.refs) },
    { role: "user", content: [image, { type: "image", source: { type: "url", url: "https://private.invalid/image" } }] },
    { role: "assistant", content: [toolUse("a", "fixture", { type: "image", arbitrary: "not a block" }), { type: "thinking", thinking: "private reasoning", signature: "secret" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [image] }] },
  ];
  const before = JSON.stringify(messages), source = JSON.stringify(historicalMessages(messages));
  expect(source).not.toContain(image.source.data); expect(source).not.toContain("private.invalid"); expect(source).not.toContain("private reasoning");
  expect(source).toContain(f.refs[0]!.id); expect(source).toContain("not a block"); expect(JSON.stringify(messages)).toBe(before);
  await summarizeOlder(messages, [], new AbortController().signal, async () => worker.provider);
  expect(JSON.stringify(worker.calls[0]!.messages)).not.toContain(image.source.data);
  for (const message of messages) {
    const entry = await f.transcript.append({ type: "message", message });
    expect(entryText(entry)).not.toContain(image.source.data); expect(entryText(entry)).not.toContain("private.invalid");
  }
  expect(JSON.parse(await queryHistory(f.project, { action: "search_history", query: f.refs[1]!.id })).entries).toHaveLength(1);
});
