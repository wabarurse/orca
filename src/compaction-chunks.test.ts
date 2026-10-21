import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentDeps } from "./agent";
import { budget, compact } from "./compaction";
import type { CompleteRequest, Provider, Turn } from "./providers/index";
import { open } from "./transcript";
import { text, toolUse } from "./test/fake-provider";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const end = (value: string): Turn => ({ content: [text(value)], stop: "end", completion: "end_turn" });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "compact-chunks-")); dirs.push(dir);
  const transcript = open(join(dir, "transcript.jsonl"));
  // A single older tool result can exceed the entire window. Include characters
  // whose JSON escaping and UTF-8 size differ from their JavaScript length.
  const payload = 'START "quoted" \\path\n😀漢字 '.repeat(5000) + " END";
  const prefix = [
    { role: "user" as const, content: "Keep the original requirements." },
    { role: "assistant" as const, content: [{ type: "thinking" as const, thinking: "private reasoning", signature: "signed" }, toolUse("old", "echo", {})] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "old", content: payload }] },
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

for (const manual of [false, true]) test(`${manual ? "manual" : "automatic"} oversized compaction resumes, preserving every source character and the tool tail`, async () => {
  const { deps, transcript, prefix, tail } = await fixture();
  const bytes = await Bun.file(transcript.path).text(), history = transcript.history!();
  const requests: CompleteRequest[] = [];
  let normal = 0;
  deps.provider = provider(async request => {
    if (!request.system?.startsWith("Summarize")) { normal++; return end("Resumed."); }
    // No intermediate checkpoint becomes visible during the sequence.
    expect(await Bun.file(transcript.path).text()).toBe(bytes);
    requests.push(request);
    return end(`Checkpoint ${requests.length}: original requirements and progress.`);
  });
  const agent = createAgent(deps);
  if (manual) await agent.compact();
  await agent.run();
  expect(requests.length).toBeGreaterThan(1);
  expect(normal).toBe(1);
  let reconstructed = "", previousSummary = "";
  for (const request of requests) {
    expect(request.tools).toEqual([]);
    expect(request.model).toBe(deps.model);
    expect(request.settings).toEqual(deps.settings);
    expect(budget({ ...deps, system: request.system, tools: {} }, request.messages) + request.maxTokens).toBeLessThanOrEqual(8000);
    const part = JSON.parse(request.messages[0]!.content as string);
    expect(part.offset).toBe(reconstructed.length);
    expect(part.previousSummary).toBe(previousSummary);
    expect(part.sourceFragment.isWellFormed()).toBe(true);
    reconstructed += part.sourceFragment;
    previousSummary = `Checkpoint ${requests.indexOf(request) + 1}: original requirements and progress.`;
  }
  const sanitized = prefix.map(message => ({ ...message, content: typeof message.content === "string" ? message.content : message.content.filter(block => block.type !== "thinking") }));
  expect(reconstructed).toBe(JSON.stringify(sanitized));
  expect(reconstructed).not.toContain("private reasoning");
  const chain = await transcript.chain();
  expect(chain[0]!.content).toContain(previousSummary);
  expect(chain[0]!.content).toContain("Keep the original requirements.");
  expect(chain.slice(1, -1)).toEqual(tail);
  expect(transcript.history!().slice(0, -1)).toEqual(history);
  expect((await Bun.file(transcript.path).text()).startsWith(bytes)).toBe(true);
  expect(await open(transcript.path).chain()).toEqual(chain);
});

for (const failure of ["offline", "truncated", "nontext", "oversized"]) test(`failure in a later summary part preserves the entire transcript: ${failure}`, async () => {
  const { deps, transcript } = await fixture();
  const bytes = await Bun.file(transcript.path).text(), head = transcript.head(), chain = await transcript.chain();
  let calls = 0;
  deps.provider = provider(async () => {
    if (++calls === 1) return end("First checkpoint.");
    if (failure === "offline") throw new Error("offline");
    if (failure === "truncated") return { ...end("Partial."), completion: "max_tokens" };
    if (failure === "nontext") return { ...end(""), content: [toolUse("bad", "echo", {})] };
    return end("x".repeat(30000));
  });
  expect(await compact(deps, true)).toBe(false);
  expect(calls).toBe(2);
  expect(transcript.head()).toBe(head);
  expect(await transcript.chain()).toEqual(chain);
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
});

test("a rolling summary that leaves no room for source stops without publishing or sending an oversized request", async () => {
  const { deps, transcript } = await fixture();
  deps.compaction!.contextLimit = 6000;
  const bytes = await Bun.file(transcript.path).text(), head = transcript.head();
  let calls = 0;
  // Some providers do not enforce maxTokens; the result still meets the
  // harness's 4096-token summary ceiling, but cannot fit the next request.
  deps.provider = provider(async () => { calls++; return end("s".repeat(12000)); });
  await expect(compact(deps, true)).rejects.toThrow("summary continuation and source fragment");
  expect(calls).toBe(1);
  expect(transcript.head()).toBe(head);
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
});

test("a failed part stops the normal turn; an explicit retry can compact the retained history and resume", async () => {
  const { deps, transcript } = await fixture();
  const bytes = await Bun.file(transcript.path).text();
  let summaries = 0, normal = 0, failed = true;
  deps.provider = provider(async request => {
    if (!request.system?.startsWith("Summarize")) { normal++; return end("Resumed."); }
    if (++summaries === 2 && failed) throw new Error("offline");
    return end("Requirements and progress.");
  });
  const agent = createAgent(deps);
  await expect(agent.run()).rejects.toThrow("Context blocked");
  expect(summaries).toBe(2); expect(normal).toBe(0);
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
  await expect(agent.run()).rejects.toThrow("Context blocked");
  expect(summaries).toBe(2);
  failed = false;
  await agent.compact();
  await agent.run();
  expect(normal).toBe(1);
});
