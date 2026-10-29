import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMemory, summarizeOlder } from "./rolling-summary";
import { RollingCompactor } from "./rolling-memory";
import { createAgent, type AgentDeps } from "../../agent-loop/loop/agent";
import { budget, estimate } from "./compaction";
import { open } from "../transcripts/transcript";
import { paths } from "../../../config";
import type { CompleteRequest, Provider, Turn } from "../../../providers/provider";
import { text } from "../../../test/fake-provider";

const valid = { summary: ["User requires preserving history."], pending: ["Finish the requested change."] };
const tooLong = { summary: Array(16).fill("x".repeat(900)), pending: [] };
// This is above the prose length target but below the unchanged token budget.
// #179 incorrectly rejected it despite enough room to carry every pending item.
const aboveTarget = { summary: Array.from({ length: 10 }, (_, i) => `Verified outcome ${i}: ` + "x".repeat(830)), pending: ["User still requires review and validation before publication."] };
const answer = (value: unknown): Turn => ({ content: [text(JSON.stringify(value))], stop: "end", completion: "completed" });
const source = [{ role: "user" as const, content: "Preserve history. Implement the requested change." }];
function scripted(turns: (Turn | Error)[]) {
  const calls: CompleteRequest[] = [];
  const provider: Provider = { name: "openai", account: "openai:phoebe", models: async () => [], complete: async request => {
    calls.push(request);
    const next = turns.shift(); if (!next) throw new Error("unexpected request"); if (next instanceof Error) throw next; return next;
  } };
  return { calls, provider, target: { model: "gpt-6-astra", loadProvider: async () => provider } };
}

test("formatting and escaped spellings do not inflate the stored memory budget", () => {
  const padded = " ".repeat(12000) + JSON.stringify(valid, null, 10);
  expect(parseMemory(padded)).toEqual(valid);
  const escaped = JSON.stringify({ summary: ["a".repeat(900), "b".repeat(900)], pending: [] }).replace(/[ab]/g, c => c === "a" ? "\\u0061" : "\\u0062");
  expect(escaped.length).toBeGreaterThan(10000);
  expect(parseMemory(escaped).summary[0]).toBe("a".repeat(900));
  expect(() => parseMemory(JSON.stringify(tooLong))).toThrow("memory exceeds output budget");
  expect(() => parseMemory(JSON.stringify({ summary: Array(5).fill("漢".repeat(900)), pending: [] }))).toThrow("memory exceeds output budget");
});

test("the character target never rejects or trims memory within the token budget", async () => {
  expect(JSON.stringify(aboveTarget).length).toBeGreaterThan(8000);
  expect(estimate(aboveTarget)).toBeLessThan(4096);
  expect(parseMemory(JSON.stringify(aboveTarget))).toEqual(aboveTarget);
  const f = scripted([answer(aboveTarget)]);
  expect(await summarizeOlder(source, new AbortController().signal, f.target)).toEqual(aboveTarget);
  expect(f.calls).toHaveLength(1); // no needless repair request
});

test("memory admission has one token boundary, including UTF-8 and JSON overhead", () => {
  const atLimit = { summary: Array(12).fill("x".repeat(1000)), pending: ["y".repeat(128)] };
  expect(estimate(atLimit)).toBe(4096);
  expect(parseMemory(JSON.stringify(atLimit))).toEqual(atLimit);
  atLimit.pending[0] += "yyy";
  expect(estimate(atLimit)).toBe(4097);
  expect(() => parseMemory(JSON.stringify(atLimit))).toThrow("4097 estimated tokens > 4096");
  // Fewer characters do not imply less model input when they occupy more bytes.
  const unicode = { summary: Array(5).fill("漢".repeat(900)), pending: [] };
  expect(JSON.stringify(unicode).length).toBeLessThan(8000);
  expect(() => parseMemory(JSON.stringify(unicode))).toThrow("estimated tokens > 4096");
});

for (const [name, invalid] of [
  ["oversized", answer(tooLong)],
  ["malformed", { ...answer(valid), content: [text("```json\nprivate malformed response")] }],
  ["invalid item", answer({ summary: ["x".repeat(1001)], pending: [] })],
  ["truncated", { ...answer(valid), stop: "limit", completion: "length" }],
] satisfies [string, Turn][]) test(`${name} generated memory gets one bounded repair using the same source and account`, async () => {
  const f = scripted([invalid, answer(valid)]), reasons: string[] = [];
  let requests = 0, parts = 0;
  expect(await summarizeOlder(source, new AbortController().signal, f.target, {
    onRequest: () => { requests++; }, onPart: () => { parts++; }, onRepair: reason => reasons.push(reason),
  })).toEqual(valid);
  expect(requests).toBe(2); expect(parts).toBe(1); expect(reasons).toHaveLength(1);
  expect(f.calls[1]!.messages).toEqual(f.calls[0]!.messages);
  expect(f.calls[1]!.trace?.purpose).toBe("rolling-summary-repair");
  expect(f.calls[1]!.system).toContain("Target at most 6000 characters");
  expect(JSON.stringify(f.calls)).not.toContain("private malformed response");
  for (const call of f.calls) { expect(call.model).toBe("gpt-6-astra"); expect(call.tools).toEqual([]); expect(call.maxTokens).toBe(4096); }
});

test("repeated invalid output stops after one repair and never exposes the rejected response", async () => {
  const f = scripted([answer(tooLong), answer(tooLong), answer(valid)]);
  await expect(summarizeOlder(source, new AbortController().signal, f.target)).rejects.toThrow("summary validation failed after 2 attempts: memory exceeds output budget");
  expect(f.calls).toHaveLength(2);
});

for (const [name, failed] of [
  ["provider failure", new Error("account unavailable")],
  ["refusal", { ...answer(valid), stop: "refusal", completion: "refusal" }],
] satisfies [string, Turn | Error][]) test(`${name} does not trigger a memory-format retry`, async () => {
  const f = scripted([failed, answer(valid)]);
  await expect(summarizeOlder(source, new AbortController().signal, f.target)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

test("cancellation before the repair prevents another request", async () => {
  const f = scripted([answer(tooLong), answer(valid)]), abort = new AbortController();
  await expect(summarizeOlder(source, abort.signal, f.target, { onRepair: () => abort.abort(new Error("cancelled")) })).rejects.toThrow("cancelled");
  expect(f.calls).toHaveLength(1);
});

const homes: string[] = [], controllers: RollingCompactor[] = [], prior = process.env.ORCA_HOME;
afterEach(() => {
  controllers.splice(0).forEach(c => c.dispose());
  if (prior === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = prior;
  homes.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));
});
async function history() {
  const home = mkdtempSync(join(tmpdir(), "summary-recovery-")); homes.push(home); process.env.ORCA_HOME = home;
  mkdirSync(paths.project("p"), { recursive: true });
  const transcript = open(paths.transcript("p", "orchestrator"));
  for (const [role, content] of [["user", "old request " + "x".repeat(500000)], ["assistant", "old work " + "y".repeat(500000)], ["user", "Latest correction: preserve history."], ["assistant", "Acknowledged."]] as const) {
    await transcript.append({ type: "message", message: { role, content } });
  }
  return transcript;
}

test("oversized memory is repaired before a smaller model's foreground request, preserving history and latest correction", async () => {
  const transcript = await history(), original = transcript.history!(), calls: CompleteRequest[] = [];
  const provider: Provider = { name: "openai", account: "openai:phoebe", models: async () => [], complete: async request => {
    calls.push(request);
    if (calls.length === 1) return answer(tooLong);
    return request.trace?.purpose === "agent" ? { ...answer(valid), content: [text("continued")] } : answer(valid);
  } };
  const rolling = new RollingCompactor("p", transcript); controllers.push(rolling);
  const deps: AgentDeps = { transcript, model: "gpt-6-astra", provider, tools: {}, ctx: { project: "p", role: "orchestrator", cwd: paths.project("p") },
    compaction: { contextLimit: 200000 }, compactBoundary: (d, m, idle) => rolling.boundary(d, m, idle), write() {} };
  expect(budget(deps, await transcript.chain())).toBeGreaterThan(200000);
  await createAgent(deps).run();
  expect(calls[1]!.trace?.purpose).toBe("rolling-summary-repair");
  expect(calls.at(-1)!.trace?.purpose).toBe("agent");
  expect(calls.filter(c => c.trace?.purpose === "agent")).toHaveLength(1);
  expect(JSON.stringify(calls.at(-1)!.messages)).toContain("Latest correction");
  expect(transcript.history!().slice(0, original.length)).toEqual(original);
  expect(budget(deps, calls.at(-1)!.messages) + calls.at(-1)!.maxTokens).toBeLessThan(160000);
});

test("history over the model window recovers with summaries above the character target, without repairs", async () => {
  const transcript = await history(), original = transcript.history!(), calls: CompleteRequest[] = [];
  const provider: Provider = { name: "openai", models: async () => [], complete: async request => {
    calls.push(request);
    return request.trace?.purpose === "agent" ? { ...answer(valid), content: [text("continued")] } : answer(aboveTarget);
  } };
  const rolling = new RollingCompactor("p", transcript); controllers.push(rolling);
  const deps: AgentDeps = { transcript, model: "gpt-6-astra", provider, tools: {}, ctx: { project: "p", role: "orchestrator", cwd: paths.project("p") },
    compaction: { contextLimit: 272000 }, compactBoundary: (d, m, idle) => rolling.boundary(d, m, idle), write() {} };
  expect(budget(deps, await transcript.chain())).toBeGreaterThan(272000);
  await createAgent(deps).run();
  expect(calls.filter(c => c.trace?.purpose === "rolling-summary").length).toBeGreaterThan(1);
  expect(calls.some(c => c.trace?.purpose === "rolling-summary-repair")).toBe(false);
  expect(calls.filter(c => c.trace?.purpose === "agent")).toHaveLength(1);
  expect(budget(deps, calls.at(-1)!.messages) + calls.at(-1)!.maxTokens).toBeLessThan(272000 * .8);
  const checkpoint = transcript.branch().find(e => e.type === "summary");
  expect(checkpoint?.type === "summary" && checkpoint.memory).toEqual(aboveTarget);
  expect(JSON.stringify(calls.at(-1)!.messages)).toContain("Latest correction");
  expect(transcript.history!().slice(0, original.length)).toEqual(original);
});

test("a hard-limit validation failure and its cooldown retain the cause without foreground requests or transcript writes", async () => {
  const transcript = await history(), bytes = await Bun.file(transcript.path).text(), f = scripted([answer(tooLong), answer(tooLong)]);
  const rolling = new RollingCompactor("p", transcript); controllers.push(rolling);
  const deps: AgentDeps = { transcript, model: "gpt-6-astra", provider: f.provider, tools: {}, ctx: { project: "p", role: "orchestrator", cwd: paths.project("p") },
    compaction: { contextLimit: 200000 }, compactBoundary: (d, m, idle) => rolling.boundary(d, m, idle), write() {} };
  for (let i = 0; i < 2; i++) await expect(createAgent(deps).run()).rejects.toThrow("compaction failed: summary validation failed after 2 attempts: memory exceeds output budget");
  expect(f.calls).toHaveLength(2); expect(await Bun.file(transcript.path).text()).toBe(bytes);
});

test("the repair gets a fresh per-request deadline rather than the remainder of the failed attempt", async () => {
  const transcript = await history(); let calls = 0;
  const provider: Provider = { name: "openai", models: async () => [], complete: async () => {
    calls++; if (calls <= 2) await Bun.sleep(130); return answer(calls === 1 ? tooLong : valid);
  } };
  const rolling = new RollingCompactor("p", transcript, { timeoutMs: 200 }); controllers.push(rolling);
  const started = Date.now();
  await rolling.boundary({ transcript, provider, model: "gpt-6-astra", tools: {}, compaction: { contextLimit: 200000 }, write() {} }, true);
  expect(Date.now() - started).toBeGreaterThan(200);
  expect(transcript.branch()[0]?.type).toBe("summary");
});
