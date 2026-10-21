import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentDeps } from "./agent";
import { compact, budget, outputCap } from "./compaction";
import { paired } from "./tool-pairs";
import { open, type Transcript } from "./transcript";
import { text, toolUse } from "./test/fake-provider";
import type { CompleteRequest, Provider, Turn } from "./providers/index";
import { createOrchestrator } from "./orchestrator";
import { put } from "./inbox";
const dirs: string[] = [];
const home = process.env.PARALLELS_HOME;
afterEach(() => { process.env.PARALLELS_HOME = home; dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const end = (s = "Goal: preserve requirements. Later amendment: use green. Progress: implemented. Next: test."): Turn => ({ content: [text(s)], stop: "end", completion: "end_turn" });
function provider(fn: (r: CompleteRequest) => Promise<Turn>): Provider { return { name: "anthropic", complete: fn, models: async () => [] }; }
async function fixture(fn: (r: CompleteRequest) => Promise<Turn> = async () => end()) {
  const dir = mkdtempSync(join(tmpdir(), "review-compact-")); dirs.push(dir); process.env.PARALLELS_HOME = dir;
  const transcript = open(join(dir, "transcript.jsonl"));
  const original = "requirements " + "x".repeat(3000) + " DO NOT DROP FINAL REQUIREMENT";
  for (const [role, content] of [["user", original], ["assistant", "old progress " + "z".repeat(33000)], ["user", "Later amendment: use green"], ["assistant", "done"], ["user", "next task"]] as const) await transcript.append({ type: "message", message: { role, content } });
  const deps: AgentDeps = { transcript, provider: provider(fn), model: "unknown", tools: {}, ctx: { project: "p", role: "worker", cwd: dir }, write: () => {}, compaction: { fallback: 20000 } };
  return { deps, transcript, original, dir };
}
async function saved(t: Transcript) { return { head: t.head(), chain: await t.chain(), history: t.history!(), bytes: await Bun.file(t.path).text() }; }
for (const completion of ["max_tokens", "refusal", "pause_turn", "incomplete", "unknown", undefined]) test(`summary terminal ${completion} never checkpoints`, async () => {
  const { deps, transcript } = await fixture(async () => ({ ...end(), completion }));
  const before = await saved(transcript); expect(await compact(deps, true)).toBe(false); expect(await saved(transcript)).toEqual(before);
});
for (const content of [[], [text("")], [toolUse("a", "bash", {})], [text("summary"), toolUse("a", "bash", {})], [{ type: "thinking", thinking: "reason", signature: "s" }], [{ type: "text", text: 42 }], [null]]) test(`summary rejects nontext/malformed ${JSON.stringify(content)}`, async () => {
  const { deps, transcript } = await fixture(async () => ({ ...end(), content: content as any }));
  const before = await saved(transcript); expect(await compact(deps, true)).toBe(false); expect(await saved(transcript)).toEqual(before);
});
test("full original >2000 chars survives repeated checkpoints; amendment remains historical data and warning identifies source", async () => {
  const { deps, transcript, original } = await fixture();
  expect(await compact(deps, true)).toBe(true);
  let context = JSON.stringify(await transcript.chain()); expect(context).toContain(original); expect(context).toContain("use green"); expect(context).toContain(transcript.path); expect(context).toContain("Best-effort lossy");
  await transcript.append({ type: "message", message: { role: "assistant", content: "new progress " + "z".repeat(20000) } });
  await transcript.append({ type: "message", message: { role: "user", content: "continue" } });
  expect(await compact(deps, true)).toBe(true); context = JSON.stringify(await transcript.chain()); expect(context).toContain(original); expect(context).toContain("use green");
});
for (const kind of ["original", "source", "system", "tools"]) test(`blocked ${kind} makes zero summary/normal requests`, async () => {
  let calls = 0; const { deps, transcript } = await fixture(async () => { calls++; return end(); });
  if (kind === "original") { deps.transcript = open(join(deps.ctx.cwd, "huge.jsonl")); await deps.transcript.append({ type: "message", message: { role: "user", content: "u".repeat(60000) } }); await deps.transcript.append({ type: "message", message: { role: "user", content: "next" } }); }
  if (kind === "source") deps.compaction!.contextLimit = 10000;
  if (kind === "system") deps.system = "s".repeat(60000);
  if (kind === "tools") deps.tools = { x: { spec: { name: "x", description: "d".repeat(60000), input_schema: { type: "object" } }, run: async () => "" } };
  const before = await saved(deps.transcript);
  await expect(createAgent(deps).run()).rejects.toThrow("Context blocked"); expect(calls).toBe(0); expect(await saved(deps.transcript)).toEqual(before);
});
test("reducing but still over-budget proposal does not commit or send normal request", async () => {
  let calls = 0; const { deps } = await fixture(async () => { calls++; return end("s".repeat(12000)); });
  deps.compaction!.contextLimit = 12000; deps.system = "f".repeat(7000);
  // Smaller older source fits summary request, but fixed instructions + proposed output do not.
  deps.transcript = open(join(deps.ctx.cwd, "proposal.jsonl"));
  for (const [role, content] of [["user", "original"], ["assistant", "a".repeat(18000)], ["user", "next"]] as const) await deps.transcript.append({ type: "message", message: { role, content } });
  const before = await saved(deps.transcript);
  await expect(createAgent(deps).run()).rejects.toThrow("proposed checkpoint"); expect(calls).toBe(1); expect(await saved(deps.transcript)).toEqual(before);
});
test("stale head refuses prepared summary", async () => {
  const { deps, transcript } = await fixture();
  deps.provider = provider(async () => { await transcript.append({ type: "message", message: { role: "user", content: "concurrent writer" } }); return end(); });
  expect(await compact(deps, true)).toBe(false); expect(transcript.branch().some(e => e.type === "summary")).toBe(false); expect((await transcript.chain()).at(-1)?.content).toBe("concurrent writer");
});
test("resolver-only snapshot once: settings/provider change during summary applies next boundary, never stale credentials", async () => {
  let resolveCount = 0; let current = "first"; const calls: { model: string; settings: unknown }[] = [];
  const { deps, transcript } = await fixture();
  const first = provider(async r => { calls.push({ model: r.model, settings: r.settings }); if (calls.length === 1) { current = "second"; return end(); } return { content: [toolUse("a", "echo", {})], stop: "tool_use" }; });
  const second = provider(async r => { calls.push({ model: r.model, settings: r.settings }); return end("done"); });
  deps.provider = undefined; deps.tools = { echo: { spec: { name: "echo", description: "echo", input_schema: { type: "object" } }, run: async () => "ok" } };
  deps.resolveModel = async () => { resolveCount++; return { model: current, provider: current === "first" ? first : second, settings: { effort: current === "first" ? "high" : "low", fast: current === "first" } }; };
  await createAgent(deps).run(); expect(resolveCount).toBe(2); expect(calls.map(c => c.model)).toEqual(["first", "first", "second"]); expect(calls[0]?.settings).toEqual(calls[1]?.settings);
  const before = await saved(transcript); deps.resolveModel = async () => { throw Error("credentials unavailable"); }; deps.provider = first;
  await expect(createAgent(deps).compact()).rejects.toThrow("credentials unavailable"); expect(await saved(transcript)).toEqual(before);
});
test("duplicate use IDs, duplicate results, wrong roles and out-of-order batches rejected; exact valid tail preserved", async () => {
  const use = toolUse("a", "echo", {}), result = { type: "tool_result" as const, tool_use_id: "a", content: "ok" };
  expect(paired([{ role: "assistant", content: [use, use] }, { role: "user", content: [result] }])).toBe(false);
  expect(paired([{ role: "assistant", content: [use] }, { role: "user", content: [result, result] }])).toBe(false);
  expect(paired([{ role: "user", content: [use, result] }])).toBe(false);
  expect(paired([{ role: "assistant", content: [use] }, { role: "user", content: "interrupt" }, { role: "user", content: [result] }])).toBe(false);
  const { deps, transcript } = await fixture();
  const assistant = { role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "private", signature: "signed" }, use, toolUse("b", "echo", {})] };
  const results = { role: "user" as const, content: [result, { ...result, tool_use_id: "b" }] };
  await transcript.append({ type: "message", message: assistant }); await transcript.append({ type: "message", message: results });
  expect(await compact(deps, true)).toBe(true); expect((await transcript.chain()).slice(-2)).toEqual([assistant, results]);
});
test("output reserve defaults/override/invalid/disabled; provider usage grows conservatively", async () => {
  const { deps } = await fixture(); expect(outputCap(deps)).toBe(4000);
  deps.compaction!.outputReserve = 1234.8; expect(outputCap(deps)).toBe(1234);
  for (const n of [NaN, Infinity, -1, 0]) { deps.compaction!.outputReserve = n; expect(outputCap(deps)).toBe(4000); }
  deps.compaction = { enabled: false, fallback: 128000 }; expect(outputCap(deps)).toBe(64000);
  deps.compaction.outputReserve = 999999; expect(outputCap(deps)).toBe(64000);
  deps.compaction.maxOutputTokens = 8192; expect(outputCap(deps)).toBe(8192);
  const chain = await deps.transcript.chain(), base = budget(deps, chain);
  deps.compaction.measured = { input: base + 1000, estimated: base, model: deps.model };
  expect(budget(deps, chain)).toBe(base + 1000);
  expect(budget(deps, [...chain, { role: "user", content: "a".repeat(3000) }])).toBeGreaterThan(base + 2000);
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { promise, release };
}
for (const mode of ["model", "tools"]) test(`manual request during busy ${mode} waits for complete boundary`, async () => {
  const entered = gate(), resume = gate(); let normal = 0, summaries = 0, tools = 0;
  const { transcript } = await fixture();
  const p = provider(async r => {
    if (r.system?.startsWith("Summarize")) { summaries++; if (mode === "tools") expect(tools).toBe(2); return end(); }
    normal++;
    if (normal === 1 && mode === "model") { entered.release(); await resume.promise; }
    if (normal === 1 && mode === "tools") return { content: [toolUse("a", "echo", {}), toolUse("b", "echo", {})], stop: "tool_use" };
    return end("normal final");
  });
  const orch = await createOrchestrator({ project: "p", transcript, provider: p, write: () => {}, tools: { echo: { spec: { name: "echo", description: "echo", input_schema: { type: "object" } }, run: async () => { tools++; if (tools === 1) { entered.release(); await resume.promise; } return "result"; } } } });
  await orch.say("user next task"); const running = orch.turn(); await entered.promise;
  await orch.compact!(); expect(summaries).toBe(0); expect(await orch.turn()).toEqual([]);
  if (mode === "tools") await put("p", "orchestrator", { from: "worker-x", text: "arrived during batch" });
  resume.release(); await running;
  expect(summaries).toBe(1); expect(normal).toBe(mode === "tools" ? 2 : 1);
  const history = JSON.stringify(orch.entries!()); expect(history).not.toContain("Summarize the supplied");
  if (mode === "tools") { expect(history).toContain("arrived during batch"); expect(paired(await transcript.chain())).toBe(true); }
});
test("failed manual suppresses auto for this agent; successful manual and model switch reset suppression", async () => {
  let summaries = 0, failed = true;
  const { deps, transcript } = await fixture(async r => {
    if (r.system?.startsWith("Summarize")) { summaries++; return failed ? { ...end(), completion: "max_tokens" } : end(); }
    return end("normal");
  });
  const agent = createAgent(deps);
  // Pressure makes failure actionable; no blind normal request after failed summary.
  await expect(agent.compact()).rejects.toThrow("Context blocked"); expect(summaries).toBe(1);
  await expect(agent.run()).rejects.toThrow("Context blocked"); expect(summaries).toBe(1);
  failed = false; await agent.compact(); expect(summaries).toBe(2);
  await transcript.append({ type: "message", message: { role: "assistant", content: "p".repeat(33000) } });
  await transcript.append({ type: "message", message: { role: "user", content: "new task" } });
  await agent.run(); expect(summaries).toBe(3);
  // A separate agent starts a fresh suppression lifetime; a changed model resets within it.
  let model = "first"; failed = true;
  await transcript.append({ type: "message", message: { role: "assistant", content: "p".repeat(33000) } });
  await transcript.append({ type: "message", message: { role: "user", content: "newer task" } });
  deps.resolveModel = async () => ({ model, provider: deps.provider! }); const switching = createAgent(deps);
  await expect(switching.run()).rejects.toThrow("Context blocked"); const count = summaries;
  await expect(switching.run()).rejects.toThrow("Context blocked"); expect(summaries).toBe(count);
  model = "second"; failed = false; await switching.run(); expect(summaries).toBe(count + 1);
});
test("normal output cap uses default/override/disabled policy and statuses use fallback writer only", async () => {
  const { deps, dir } = await fixture();
  const requests: CompleteRequest[] = [];
  deps.transcript = open(join(dir, "simple.jsonl")); await deps.transcript.append({ type: "message", message: { role: "user", content: "hello" } });
  deps.provider = provider(async r => { requests.push(r); return end("normal"); });
  await createAgent(deps).run(); expect(requests.at(-1)?.maxTokens).toBe(4000);
  deps.compaction!.outputReserve = 1234; await createAgent(deps).run(); expect(requests.at(-1)?.maxTokens).toBe(1234);
  deps.compaction = { enabled: false, fallback: 128000 }; await createAgent(deps).run(); expect(requests.at(-1)?.maxTokens).toBe(64000);
  const f = await fixture(); f.deps.write = undefined; const output: string[] = [];
  const write = process.stdout.write; process.stdout.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as typeof write;
  try { await createAgent(f.deps).compact(); } finally { process.stdout.write = write; }
  expect(output.join("")).toContain("compacting…"); expect(output.join("")).toContain("compaction complete"); expect(JSON.stringify(await f.transcript.chain())).not.toContain("compacting…");
});
test("Anthropic carries terminal reason and cache-inclusive usage while retaining sanitizer/settings/headers", async () => {
  const { anthropic } = await import("./providers/anthropic"); let reason = "max_tokens"; let sent: any, options: any;
  const client = { messages: { stream: (request: any, opts: any) => { sent = request; options = opts; return { on() {}, finalMessage: async () => ({ content: [text("partial")], stop_reason: reason, usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 } }) }; } } };
  const p = anthropic(client as any);
  const request: CompleteRequest = { model: "claude-opus-5", settings: { effort: "high", fast: true }, system: "role", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "foreign", signature: JSON.stringify({ provider: "codex" }) }, text("ok")] }], tools: [], maxTokens: 2048, onText() {} };
  const result = await p.complete(request); expect(result.completion).toBe("max_tokens"); expect(result.inputTokens).toBe(600); expect(result.stop).toBe("end");
  expect(sent.messages[0].content).toEqual([text("ok")]); expect(sent.output_config.effort).toBe("high"); expect(sent.speed).toBe("fast"); expect(options.headers["anthropic-beta"]).toContain("fast-mode");
  reason = "refusal"; expect((await p.complete(request)).completion).toBe("refusal");
});
test("actual project config changes during gated summary are deferred until the next boundary", async () => {
  const { saveProjectModel, projectModelResolver } = await import("./project-model");
  const { saveProjectSettings } = await import("./project-settings");
  const { paths } = await import("./config"); const { mkdirSync } = await import("node:fs");
  const { deps } = await fixture(); mkdirSync(paths.project("p"), { recursive: true });
  await saveProjectModel("p", "claude-opus-5"); await saveProjectSettings("p", "claude-opus-5", { effort: "high", fast: true });
  const entered = gate(), resume = gate(); const calls: CompleteRequest[] = [];
  const p = provider(async r => { calls.push(r); if (calls.length === 1) { entered.release(); await resume.promise; return end(); } if (calls.length === 2) return { content: [toolUse("a", "echo", {})], stop: "tool_use" }; return end("final"); });
  deps.tools = { echo: { spec: { name: "echo", description: "echo", input_schema: { type: "object" } }, run: async () => "ok" } };
  const resolver = projectModelResolver("p", async () => p); let resolutions = 0;
  deps.provider = undefined; deps.resolveModel = async () => { resolutions++; return resolver(); };
  const run = createAgent(deps).run(); await entered.promise;
  await saveProjectModel("p", "gpt-6-astra"); await saveProjectSettings("p", "gpt-6-astra", { effort: "low", fast: false });
  resume.release(); await run;
  expect(resolutions).toBe(2); expect(calls.map(c => c.model)).toEqual(["claude-opus-5", "claude-opus-5", "gpt-6-astra"]);
  expect(calls[0]?.settings).toEqual({ effort: "high", fast: true }); expect(calls[1]?.settings).toEqual(calls[0]?.settings); expect(calls[2]?.settings).toEqual({ effort: "low", fast: false });
});
test("actual usage from a normal request triggers the next boundary compaction with conservative growth", async () => {
  const calls: string[] = [];
  const { deps } = await fixture(async r => {
    if (r.system?.startsWith("Summarize")) { calls.push("summary"); return end(); }
    calls.push("normal");
    if (calls.length === 1) return { content: [toolUse("a", "echo", {})], stop: "tool_use", completion: "tool_use", inputTokens: 23000 };
    return end("done");
  });
  deps.compaction!.fallback = 30000;
  deps.tools = { echo: { spec: { name: "echo", description: "echo", input_schema: { type: "object" } }, run: async () => "result " + "r".repeat(300) } };
  await createAgent(deps).run(); expect(calls).toEqual(["normal", "summary", "normal"]);
});
