import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { paths } from "../../../config/config";
import { createOrchestrator } from "../../agent-loop/orc/orchestrator";
import { content, consume, pending, put } from "../inbox/inbox";
import { createAgent } from "../../agent-loop/loop/agent";
import { open } from "../transcripts/transcript";
import { imageBlock, imageContent, loadImage, materializeImages, pendingImageInputs, saveImage, saveImageInput, validateRefs } from "./images";
import { MAX_IMAGE_BYTES, validatedBase64, validateImage } from "../../../providers/images";
import { forwardImages } from "../../tools/attachments";
import { message } from "../../tools/message";
import { makeSpawn } from "../../tools/spawn";
import { registerTask } from "../tasks/tasks";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, claudeMessages } from "../../../providers/anthropic";
import { toResponses } from "../../../providers/openai";
import { compact, estimate } from "../memory/compaction";
import { fakeProvider, text } from "../../../test/fake-provider";
import { png } from "../../../test/image-fixture";
import { render } from "../../../tui/conversation/view";
import { restore } from "../../../tui/conversation/restore";
import { legacy } from "../../../config/legacy";

const home = mkdtempSync(join(tmpdir(), "orca-images-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
function project() { const id = `p-${crypto.randomUUID()}`; mkdirSync(paths.project(id), { recursive: true }); return id; }
const ctx = (project: string) => ({ project, role: "orchestrator" as const, cwd: home });
function imageCount(messages: MessageParam[]) { return messages.flatMap(m => typeof m.content === "string" ? [] : m.content).filter(b => b.type === "image").length; }

test("saved pre-rename image references still materialize, while new references use orca", async () => {
  const p = project(), ref = await saveImage(p, png());
  const block = imageBlock(ref);
  expect(block.source.type).toBe("url");
  if (block.source.type !== "url") throw new Error("expected local image reference");
  expect(block.source.url.startsWith("orca-image:")).toBe(true);
  block.source.url = block.source.url.replace("orca-image:", legacy.imagePrefix);
  const messages = await materializeImages(p, [{ role: "user", content: [block] }]);
  expect(JSON.stringify(messages)).toContain('"type":"base64"');
  await expect(materializeImages(project(), [{ role: "user", content: [block] }])).rejects.toThrow("another/deleted");
});

test("PNG validation rejects invalid MIME, empty/truncated, wrong CRC, excessive bytes/dimensions, and compressed bombs", () => {
  expect(validateImage(png())).toEqual({ width: 1, height: 1 });
  expect(() => validateImage(png(), "image/jpeg")).toThrow("unsupported");
  expect(() => validateImage(Buffer.alloc(0))).toThrow();
  expect(() => validateImage(png().subarray(0, 20))).toThrow();
  expect(() => validateImage(Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow("4 mib");
  const corrupt = png(); corrupt[45] = corrupt[45]! ^ 1; expect(() => validateImage(corrupt)).toThrow("crc");
  expect(() => validateImage(png(4097))).toThrow("dimensions");
  expect(() => validateImage(png(1, 1, 128, Buffer.alloc(10000)))).toThrow();
  expect(() => validateImage(png(1, 1, 128, Buffer.from([5, 0, 0, 0, 255])))).toThrow("filter");
  expect(() => validatedBase64({ type: "image", source: { type: "base64", media_type: "image/png", data: "////???" } })).toThrow("base64");
});

test("atomic storage persists real bytes, rejects traversal/cross-project references/symlinks/corruption", async () => {
  const a = project(), b = project(), ref = await saveImage(a, png());
  expect(await loadImage(a, ref)).toEqual(png());
  expect([...readFileSync(join(paths.project(a), "images", `${ref.id}.png`))]).toEqual([...png()]);
  await expect(loadImage(b, ref)).rejects.toThrow("another/deleted");
  await expect(loadImage(a, { ...ref, id: "../../secret" })).rejects.toThrow("reference");
  await expect(validateRefs(a, [ref, ref])).rejects.toThrow("duplicate");
  await expect(validateRefs(a, Array(5).fill(ref))).rejects.toThrow("at most 4");
  const path = join(paths.project(a), "images", `${ref.id}.png`);
  writeFileSync(path, "corrupt"); await expect(loadImage(a, ref)).rejects.toThrow("corrupt");
  rmSync(path); const outside = join(home, "outside.png"); writeFileSync(outside, png()); symlinkSync(outside, path);
  await expect(loadImage(a, ref)).rejects.toThrow();
});

test.each(["claude-fable-5-1", "claude-unknown", "gpt-unknown"])("image model %s: queue -> exact committed transcript -> Claude AND Codex bytes, ordered, durable", async model => {
  const prompt = "inspect screenshot";
  const p = project(), refs = [await saveImage(p, png()), await saveImage(p, png(2, 1, 250))];
  const inputId = crypto.randomUUID();
  await saveImageInput(p, { text: prompt, inputId, attachments: refs });
  await put(p, "orchestrator", { from: "user", text: prompt, inputId, attachments: refs });
  const transcript = open(paths.transcript(p, "orchestrator"));
  const provider = fakeProvider([[text("done")]]);
  await createAgent({ transcript, provider, model, tools: {}, ctx: ctx(p), write() {}, compaction: { enabled: false } }).run();
  expect(await pending(p, "orchestrator")).toBe(false);
  expect(transcript.consumed!().inputs.has(inputId)).toBe(true);
  expect(await pendingImageInputs(p, transcript.consumed!().inputs)).toEqual([]);
  const saved = readFileSync(transcript.path, "utf8");
  expect(saved).toContain("orca-image:"); expect(saved).not.toContain(png().toString("base64"));
  const loaded = open(transcript.path), messages = await loaded.chain();
  expect(imageCount(messages)).toBe(2);
  const bytes = await materializeImages(p, messages);
  expect(provider.calls[0]!.messages).toEqual(bytes.slice(0, 1));
  const claude = claudeMessages(bytes);
  const blocks = claude[0]!.content;
  expect(Array.isArray(blocks) && blocks.filter(b => b.type === "image").map(b => b.source.type === "base64" ? b.source.data : "")).toEqual([png().toString("base64"), png(2, 1, 250).toString("base64")]);
  const codex = toResponses(bytes) as any[];
  expect(codex[0].content.map((b: any) => b.type)).toEqual(["input_text", "input_text", "input_image", "input_text", "input_image"]);
  expect(codex[0].content.filter((b: any) => b.type === "input_image").map((b: any) => b.image_url)).toEqual([png(), png(2, 1, 250)].map(b => `data:image/png;base64,${b.toString("base64")}`));
  expect(loaded.history!().map(e => render(e)).join("\n")).toContain("Image 1");
  expect(loaded.history!().map(e => render(e)).join("\n")).not.toContain("base64");
  const restored = JSON.stringify(restore(loaded.history!(), 80));
  expect(restored).toContain("[image 1] [image 2]");
  expect(restored).not.toContain("orca-image:");
  expect(restored).not.toContain(png().toString("base64"));
  // Duplicate input ID after interrupted cleanup/retry cannot replay the prompt.
  await put(p, "orchestrator", { from: "user", text: prompt, inputId, attachments: refs });
  const second = fakeProvider([]);
  await createAgent({ transcript: loaded, provider: second, model: "claude-sonnet-4-6", tools: {}, ctx: ctx(p), requireInbox: true, write() {} }).run();
  expect(second.calls).toHaveLength(0);
});

test.each(["orchestrator", "worker", "reviewer"] as const)("%s on GPT-6 Astra receives materialized image input", async role => {
  const p = project(), ref = await saveImage(p, png());
  const branch = role === "orchestrator" ? undefined : "vision";
  const id = branch ? `${role}-${branch}` : "orchestrator";
  const t = open(paths.transcript(p, id));
  await put(p, id, { from: "user", text: "inspect screenshot", attachments: [ref] });
  const provider = fakeProvider([[text("seen")]]);
  const complete = provider.complete;
  provider.complete = async req => { expect(req.model).toBe("gpt-6-astra"); return complete(req); };
  await createAgent({ transcript: t, provider, model: "gpt-6-astra", tools: {},
    ctx: { ...ctx(p), role, branch }, write() {}, compaction: { enabled: false } }).run();
  expect(provider.calls).toHaveLength(1);
  const blocks = provider.calls[0]!.messages.flatMap(m => typeof m.content === "string" ? [] : m.content);
  expect(blocks.filter(b => b.type === "image")).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: png().toString("base64") } },
  ]);
  expect(imageCount(await t.chain())).toBe(1);
});

test("same text/different immutable prompt IDs consume independently; old text files keep exact format", async () => {
  const p = project(), ref = await saveImage(p, png());
  const t = open(paths.transcript(p, "orchestrator"));
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const inputId of ids) await put(p, "orchestrator", { from: "user", text: "same", inputId, attachments: [ref] });
  const messages = await consume(p, "orchestrator", t, async inbox => { await t.append({ type: "message", inbox, message: { role: "user", content: content(inbox) } }); });
  expect(messages.map(m => m.inputId)).toEqual(ids);
  expect(t.consumed!().inputs.size).toBe(2);
  expect(content([{ from: "user", text: "old", ts: "" }])).toBe("[user] old");
});

test("failed transcript commit retains inbox and image ownership; failed serialization is explicit, with no text-only fallback", async () => {
  const p = project(), ref = await saveImage(p, png()), t = open(paths.transcript(p, "orchestrator"));
  await put(p, "orchestrator", { from: "user", text: "", attachments: [ref] });
  await expect(consume(p, "orchestrator", t, async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");
  expect(await pending(p, "orchestrator")).toBe(true); expect(await loadImage(p, ref)).toEqual(png());
  const refs: MessageParam[] = [{ role: "user", content: imageContent("", [ref]) }];
  expect(() => toResponses(refs)).toThrow("not resolved"); expect(() => claudeMessages(refs)).toThrow("not resolved");
  rmSync(join(paths.project(p), "images", `${ref.id}.png`));
  await expect(materializeImages(p, refs)).rejects.toThrow();
  await expect(consume(p, "orchestrator", t, async () => {})).rejects.toThrow();
  expect(await pending(p, "orchestrator")).toBe(true);
});

test("durable recovery never replays, immutable journal rejects changed identity, consumed records excluded", async () => {
  const p = project(), ref = await saveImage(p, png());
  const input = { inputId: crypto.randomUUID(), text: "draft", attachments: [ref], submission: "captured" };
  await saveImageInput(p, input); await saveImageInput(p, input);
  expect(await pendingImageInputs(p)).toEqual([input]);
  await expect(saveImageInput(p, { ...input, text: "changed" })).rejects.toThrow("immutable");
  expect(await pendingImageInputs(p, new Set([input.inputId]))).toEqual([]);
  expect(await pending(p, "orchestrator")).toBe(false);
});

test("explicit spawn and message handoff grants only received images, worker gets actual pixels in both serializers", async () => {
  const p = project(), ref = await saveImage(p, png()), secret = await saveImage(p, png(2));
  const parent = open(paths.transcript(p, "orchestrator"));
  await parent.append({ type: "message", message: { role: "user", content: imageContent("visual task", [ref]) } });
  const task = await registerTask(p, { name: "Vision", summary: "visual fixture", branch: "visual", authorized: true });
  let started = false;
  const spawn = makeSpawn({ running: async () => [], start: async () => { started = true; } } as any);
  const id = await spawn.run({ prompt: "implement visual task", branch: "visual", taskId: task.id, attachments: [ref.id] }, ctx(p));
  expect(started).toBe(true); expect(id).toBe("worker-visual");
  const worker = open(paths.transcript(p, id));
  const materialized = await materializeImages(p, await worker.chain());
  expect(imageCount(claudeMessages(materialized))).toBe(1);
  expect(JSON.stringify(toResponses(materialized))).toContain(png().toString("base64"));
  await expect(forwardImages([secret.id], ctx(p))).rejects.toThrow("not received");
  await message.run({ to: id, text: "inspect this too", attachments: [ref.id] }, ctx(p));
  const provider = fakeProvider([[text("received")]]);
  await createAgent({ transcript: worker, provider, model: "gpt-5.5", tools: {}, ctx: { ...ctx(p), role: "worker", branch: "visual" }, write() {}, compaction: { enabled: false } }).run();
  expect(imageCount(provider.calls[0]!.messages)).toBe(2);
  expect(await forwardImages(undefined, ctx(p))).toEqual([]);
  await parent.append({ type: "context-boundary" });
  await expect(forwardImages([ref.id], ctx(p))).rejects.toThrow("not received");
});

test("compaction budgets pixels rather than base64, retains inspectable image blocks and explicit handoff IDs", async () => {
  const p = project(), ref = await saveImage(p, png()), t = open(paths.transcript(p, "orchestrator"));
  await t.append({ type: "message", message: { role: "user", content: imageContent("original task", [ref]) } });
  await t.append({ type: "message", message: { role: "assistant", content: "long history ".repeat(8000) } });
  await t.append({ type: "message", message: { role: "user", content: "next" } });
  const provider = fakeProvider([[text("summarized history")]]);
  expect(await compact({ transcript: t, provider, model: "claude-sonnet-4-6", tools: {}, write() {}, compaction: { contextLimit: 128000 } }, true)).toBe(true);
  const chain = await t.chain();
  expect(imageCount(chain)).toBe(1);
  expect(imageCount(await materializeImages(p, chain))).toBe(1);
  expect(JSON.stringify(provider.calls[0]!.messages)).not.toContain("base64");
  expect(await forwardImages([ref.id], ctx(p))).toEqual([ref]);
  expect(estimate([{ role: "user", content: [imageBlock(ref)] }])).toBeLessThan(6200);
  expect(estimate({ type: "image", source: { type: "base64", data: "X".repeat(1000000) } })).toBeLessThan(6200);
});

test("provider failure on an unknown model preserves committed pixels; refresh cannot replay, explicit new prompt resumes", async () => {
  const p = project(), ref = await saveImage(p, png()), t = open(paths.transcript(p, "orchestrator"));
  const inputId = crypto.randomUUID();
  await saveImageInput(p, { inputId, text: "inspect", attachments: [ref] });
  await put(p, "orchestrator", { from: "user", text: "inspect", inputId, attachments: [ref] });
  const unsupported = fakeProvider([]);
  unsupported.complete = async req => { expect(req.model).toBe("text-only-unknown"); unsupported.calls.push({ messages: req.messages, tools: [] }); throw new Error("fixture provider rejected image"); };
  const deps = { transcript: t, tools: {}, ctx: ctx(p), write() {}, compaction: { enabled: false }, requireInbox: true };
  await expect(createAgent({ ...deps, provider: unsupported, model: "text-only-unknown" }).run()).rejects.toThrow("provider rejected image");
  expect(unsupported.calls).toHaveLength(1);
  expect(imageCount(unsupported.calls[0]!.messages)).toBe(1);
  expect(t.consumed!().inputs.has(inputId)).toBe(true);
  expect(imageCount(await open(t.path).chain())).toBe(1);
  const failed = { ...fakeProvider([]), complete: async () => { throw new Error("fixture provider rejected image"); } };
  await put(p, "orchestrator", { from: "user", text: "resume on chosen vision model" });
  await expect(createAgent({ ...deps, provider: failed, model: "gpt-6-astra" }).run()).rejects.toThrow("provider rejected");
  expect(imageCount(await t.chain())).toBe(1);
  const good = fakeProvider([[text("seen")]]);
  await createAgent({ ...deps, provider: good, model: "gpt-6-astra" }).run();
  expect(good.calls).toHaveLength(0); // No new input: failed request never auto-replays.
  await put(p, "orchestrator", { from: "user", text: "retry now" });
  await createAgent({ ...deps, provider: good, model: "gpt-6-astra" }).run();
  expect(imageCount(good.calls[0]!.messages)).toBe(1);
  expect(await pendingImageInputs(p, t.consumed!().inputs)).toEqual([]);
});

test("durable image-only input blocks clear; consumed images survive clear/reopen but cannot cross context or project generations", async () => {
  const p = project(), ref = await saveImage(p, png()), inputId = crypto.randomUUID();
  const provider = fakeProvider([[text("seen")]]);
  const orch = await createOrchestrator({ project: p, provider, tools: {}, write() {} });
  await saveImageInput(p, { inputId, text: "", attachments: [ref] });
  await expect(orch.checkClear!()).rejects.toThrow("image input is pending");
  await orch.say("", undefined, inputId, [ref]); await orch.turn();
  await orch.clear!();
  const t = open(paths.transcript(p, "orchestrator"));
  expect(await t.chain()).toEqual([]);
  expect(await loadImage(p, ref)).toEqual(png());
  expect(t.consumed!().inputs.has(inputId)).toBe(true);
  expect(await pendingImageInputs(p, t.consumed!().inputs)).toEqual([]);
  await expect(forwardImages([ref.id], ctx(p))).rejects.toThrow("not received");
  rmSync(paths.project(p), { recursive: true }); mkdirSync(paths.project(p));
  await expect(loadImage(p, ref)).rejects.toThrow("another/deleted");
});

test("image journal recovery is ordered by publication time, never random UUID order", async () => {
  const p = project(), ref = await saveImage(p, png());
  const ids = ["ffffffff-ffff-4fff-afff-ffffffffffff", "00000000-0000-4000-a000-000000000000"];
  for (const [n, inputId] of ids.entries()) {
    await saveImageInput(p, { inputId, text: String(n), attachments: [ref] });
    const path = join(paths.project(p), "image-inputs", `${inputId}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8")); saved.storedAt = `2026-01-01T00:00:0${n}.000Z`;
    writeFileSync(path, JSON.stringify(saved));
  }
  expect((await pendingImageInputs(p)).map(i => i.inputId)).toEqual(ids);
});


test("provider serializers refuse assistant and nested tool images rather than dropping or flattening them", () => {
  const block = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: png().toString("base64") } };
  const assistant: MessageParam[] = [{ role: "assistant", content: [block] }];
  const nested: MessageParam[] = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "fixture", content: [block] }] }];
  for (const serialize of [claudeMessages, toResponses]) {
    expect(() => serialize(assistant)).toThrow("assistant image");
    expect(() => serialize(nested)).toThrow("nested tool images");
  }
});

// Exercise the actual Claude adapter without credentials or network requests.
test.each(["claude-fable-5-1", "claude-unknown"])("%s sends validated images unchanged to Claude", async model => {
  const messages: MessageParam[] = [{ role: "user", content: [{ type: "image", source: {
    type: "base64", media_type: "image/png", data: png().toString("base64"),
  } }] }];
  let calls = 0;
  const client = { messages: { stream(req: { model: string; messages: MessageParam[] }) {
    calls++;
    expect(req.model).toBe(model);
    expect(req.messages).toEqual(messages);
    return { on() {}, async finalMessage() { return { content: [], stop_reason: "end_turn" }; } };
  } } } as unknown as Anthropic;
  const provider = anthropic(client);
  await provider.complete({ model, messages, tools: [], maxTokens: 100, onText() {} });
  expect(calls).toBe(1);
  const malformed: MessageParam[] = [{ role: "user", content: [{ type: "image", source: {
    type: "base64", media_type: "image/png", data: "invalid!",
  } }] }];
  await expect(provider.complete({ model, messages: malformed, tools: [], maxTokens: 100, onText() {} })).rejects.toThrow("base64");
  expect(() => toResponses(malformed)).toThrow("base64");
  expect(calls).toBe(1);
});
