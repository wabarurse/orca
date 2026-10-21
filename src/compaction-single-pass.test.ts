import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentDeps } from "./agent";
import { budget, compact } from "./compaction";
import type { CompleteRequest, Provider, Turn } from "./providers/index";
import { open } from "./transcript";
import { text, toolUse } from "./test/fake-provider";
import { openai } from "./providers/openai";
import { codexSSE, fakeCodexTokens } from "./test/codex";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const end = (value: string): Turn => ({ content: [text(value)], stop: "end", completion: "end_turn" });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "compact-single-")); dirs.push(dir);
  const transcript = open(join(dir, "transcript.jsonl"));
  // A single older tool result can exceed the entire window. Include characters
  // whose JSON escaping and UTF-8 size differ from their JavaScript length.
  const payload = 'START "quoted" \\path\n😀漢字 '.repeat(5000) + " END";
  const prefix = [
    { role: "user" as const, content: "Keep the original requirements." },
    { role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "private reasoning", signature: "signed" }, toolUse("old", "echo", {})] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "old", content: payload }, text("Amendment: keep the top and bottom bars sticky.")] },
    { role: "assistant" as const, content: "Old work complete." },
  ];
  const tail = [
    { role: "user" as const, content: "Continue with the latest change." },
    { role: "assistant" as const, content: [toolUse("recent", "echo", {})] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "recent", content: "latest result" }] },
  ];
  for (const message of [...prefix, ...tail]) await transcript.append({ type: "message", message });
  const deps: AgentDeps = { transcript, model: "unknown", settings: { effort: "high", fast: true }, tools: {}, ctx: { project: "chunk-test", role: "worker", cwd: dir }, write: () => {}, compaction: { contextLimit: 10000 } };
  return { deps, transcript, prefix, tail };
}
function provider(complete: Provider["complete"]): Provider { return { name: "anthropic", models: async () => [], complete }; }

for (const manual of [false, true]) test(`${manual ? "manual" : "automatic"} oversized compaction uses one bounded request and preserves the tool tail`, async () => {
  const { deps, transcript, tail } = await fixture();
  const bytes = await Bun.file(transcript.path).text(), history = transcript.history!();
  const requests: CompleteRequest[] = [];
  let normal = 0;
  deps.provider = provider(async request => {
    if (!request.system?.startsWith("Summarize")) { normal++; return end("Resumed."); }
    expect(await Bun.file(transcript.path).text()).toBe(bytes);
    requests.push(request);
    return end("Original requirements and progress.");
  });
  const agent = createAgent(deps);
  if (manual) await agent.compact();
  await agent.run();
  expect(requests).toHaveLength(1);
  expect(normal).toBe(1);
  for (const request of requests) {
    expect(request.tools).toEqual([]);
    expect(request.model).toBe(deps.model);
    expect(request.settings).toEqual(deps.settings);
    expect(budget({ ...deps, system: request.system, tools: {} }, request.messages) + request.maxTokens).toBeLessThanOrEqual(8000);
    const source = request.messages[0]!.content as string;
    expect(source.isWellFormed()).toBe(true);
    expect(source).toContain("omitted; full text is in the transcript");
    expect(source).toContain("Amendment: keep the top and bottom bars sticky.");
    expect(source).toContain("START"); expect(source).toContain("END");
    expect(source).not.toContain("private reasoning");
    expect(JSON.parse(source)).toHaveLength(4);
  }
  const chain = await transcript.chain();
  expect(chain[0]!.content).toContain("Original requirements and progress.");
  expect(chain[0]!.content).toContain("Keep the original requirements.");
  expect(chain.slice(1, -1)).toEqual(tail);
  expect(transcript.history!().slice(0, -1)).toEqual(history);
  expect((await Bun.file(transcript.path).text()).startsWith(bytes)).toBe(true);
  expect(await open(transcript.path).chain()).toEqual(chain);
});

for (const failure of ["offline", "truncated", "nontext", "oversized"]) test(`failed single summary preserves the entire transcript: ${failure}`, async () => {
  const { deps, transcript } = await fixture();
  const bytes = await Bun.file(transcript.path).text(), head = transcript.head(), chain = await transcript.chain();
  let calls = 0;
  deps.provider = provider(async () => {
    calls++;
    if (failure === "offline") throw new Error("offline");
    if (failure === "truncated") return { ...end("Partial."), completion: "max_tokens" };
    if (failure === "nontext") return { ...end(""), content: [toolUse("bad", "echo", {})] };
    return end("x".repeat(30000));
  });
  expect(await compact(deps, true)).toBe(false);
  expect(calls).toBe(1);
  expect(transcript.head()).toBe(head);
  expect(await transcript.chain()).toEqual(chain);
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
});

test("oversized prose is excerpted with both ends, then summarized once within budget", async () => {
  const { deps, transcript } = await fixture();
  await transcript.append({ type: "message", message: { role: "assistant", content: "BEGIN " + '😀漢字 "\\\n'.repeat(20000) + " FINISH" } });
  await transcript.append({ type: "message", message: { role: "user", content: "Continue" } });
  const bytes = await Bun.file(transcript.path).text();
  let calls = 0;
  deps.provider = provider(async request => {
    calls++;
    const source = request.messages[0]!.content as string;
    expect(source).toContain("Keep the original requirements.");
    expect(source).toContain("FINISH");
    expect(source).toContain("omitted; full text is in the transcript");
    expect(source.isWellFormed()).toBe(true);
    expect(budget({ ...deps, system: request.system, tools: {} }, request.messages) + request.maxTokens).toBeLessThanOrEqual(8000);
    return end("Requirements and progress.");
  });
  expect(await compact(deps, true)).toBe(true);
  expect(calls).toBe(1);
  expect((await Bun.file(transcript.path).text()).startsWith(bytes)).toBe(true);
});

test("a failed summary stops the normal turn; an explicit retry can compact retained history and resume", async () => {
  const { deps, transcript } = await fixture();
  const bytes = await Bun.file(transcript.path).text();
  let summaries = 0, normal = 0, failed = true;
  deps.provider = provider(async request => {
    if (!request.system?.startsWith("Summarize")) { normal++; return end("Resumed."); }
    summaries++;
    if (failed) throw new Error("offline");
    return end("Requirements and progress.");
  });
  const agent = createAgent(deps);
  await expect(agent.run()).rejects.toThrow("Context blocked");
  expect(summaries).toBe(1); expect(normal).toBe(0);
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
  await expect(agent.run()).rejects.toThrow("Context blocked");
  expect(summaries).toBe(1);
  failed = false;
  await agent.compact();
  await agent.run();
  expect(normal).toBe(1);
});

test("successful Codex reasoning plus summary checkpoints and resumes through the actual adapter", async () => {
  const { deps, transcript } = await fixture();
  const requests: any[] = [];
  const mocked = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: any, init?: any) => {
    requests.push(JSON.parse(init.body));
    return codexSSE([{ type: "response.completed", response: { status: "completed", output: [
      { type: "reasoning", id: "rs_summary", summary: [], encrypted_content: "summary-reasoning" },
      { type: "message", id: "msg_summary", role: "assistant", status: "completed", content: [{ type: "output_text", text: requests.length === 1 ? "Requirements and progress." : "Resumed.", annotations: [] }] },
    ] } }]);
  }, { preconnect: fetch.preconnect }));
  try {
    deps.model = "gpt-6-astra";
    deps.provider = openai(async () => fakeCodexTokens());
    await createAgent(deps).run();
    expect(requests).toHaveLength(2);
    const checkpoint = (await transcript.chain())[0]!.content;
    expect(checkpoint).toContain("Requirements and progress.");
    expect(checkpoint).not.toContain("summary-reasoning");
    expect(JSON.stringify(requests[1].input)).toContain("Requirements and progress.");
    expect(JSON.stringify(requests[1].input)).not.toContain("summary-reasoning");
  } finally { mocked.mockRestore(); }
});
