import { afterEach, expect, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentDeps } from "../../agent-loop/loop/agent";
import { budget, compact, outputCap } from "./compaction";
import type { CompleteRequest, Turn } from "../../../providers/provider";
import { open } from "../transcripts/transcript";
import { paired } from "../transcripts/tool-pairs";
import { text, toolUse } from "../../../test/fake-provider";

const dirs: string[] = [];
const oldHome = process.env.ORCA_HOME;
afterEach(() => {
  process.env.ORCA_HOME = oldHome;
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const end = (value: string): Turn => ({ content: [text(value)], stop: "end", completion: "end_turn" });
const original = "Implement the feature, preserve the existing API, and run the tests.";
const reasoning = { type: "thinking" as const, thinking: "plan", signature: "signed" };
const result = (id: string, content: string) => ({ type: "tool_result" as const, tool_use_id: id, content });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "compact-batches-")); dirs.push(dir); process.env.ORCA_HOME = dir;
  const transcript = open(join(dir, "transcript.jsonl"));
  await transcript.append({ type: "message", message: { role: "user", content: original } });
  const deps: AgentDeps = { transcript, model: "unknown", tools: {}, ctx: { project: "batches", role: "worker", cwd: dir },
    compaction: { contextLimit: 10000 }, write() {} };
  const append = async (messages: MessageParam[]) => {
    for (const message of messages) await transcript.append({ type: "message", message });
  };
  return { deps, transcript, append };
}

for (const manual of [false, true]) test(`${manual ? "manual" : "automatic"} compaction within one user task retains the newest complete batch verbatim`, async () => {
  const { deps, transcript, append } = await fixture();
  await append([
    { role: "assistant", content: [reasoning, toolUse("old", "echo", {})] },
    { role: "user", content: [result("old", "old output ".repeat(10000))] },
  ]);
  const tail: MessageParam[] = [
    { role: "assistant", content: [reasoning, toolUse("recent-a", "echo", {}), toolUse("recent-b", "echo", {})] },
    { role: "user", content: [result("recent-a", "first result"), result("recent-b", "second result"), text("Keep this latest amendment.")] },
  ];
  await append(tail);
  const bytes = await Bun.file(transcript.path).text(), history = transcript.history!().filter(e => e.type !== "model-request");
  const calls: CompleteRequest[] = [];
  deps.provider = { name: "anthropic", models: async () => [], complete: async request => {
    calls.push(request);
    expect(budget({ ...deps, system: request.system, tools: {} }, request.messages) + request.maxTokens).toBeLessThanOrEqual(8000);
    if (calls.length === 1) {
      expect(request.system).toStartWith("Summarize");
      expect(JSON.stringify(request.messages)).toContain("old output");
      expect(JSON.stringify(request.messages)).not.toContain("recent-a");
      expect(await Bun.file(transcript.path).text()).toBe(bytes);
      return end("The feature is implemented; next run the tests.");
    }
    expect(request.messages.slice(1)).toEqual(tail);
    expect(paired(request.messages)).toBe(true);
    return end("Done.");
  } };
  const agent = createAgent(deps);
  if (manual) await agent.compact();
  await agent.run();
  expect(calls).toHaveLength(2);
  const context = await transcript.chain();
  expect(context[0]!.content).toContain(original);
  expect(context.slice(1, -1)).toEqual(tail);
  expect(transcript.history!().filter(e => e.type !== "model-request").slice(0, -1)).toEqual(history);
  expect((await Bun.file(transcript.path).text()).startsWith(bytes)).toBe(true);
  expect(await open(transcript.path).chain()).toEqual(context);
});

test("a live oversized tool batch is summarized once, then work resumes without re-executing either tool", async () => {
  const { deps, transcript } = await fixture();
  let executions = 0, normal = 0, summaries = 0;
  const output = "completed output ".repeat(10000);
  deps.tools = { echo: { spec: { name: "echo", description: "echo", input_schema: { type: "object" } }, run: async () => { executions++; return output; } } };
  deps.provider = { name: "anthropic", models: async () => [], complete: async request => {
    if (request.system?.startsWith("Summarize")) {
      summaries++;
      expect(executions).toBe(2);
      expect(request.tools).toEqual([]);
      expect(budget({ ...deps, system: request.system, tools: {} }, request.messages) + request.maxTokens).toBeLessThanOrEqual(8000);
      return end("Both commands completed successfully. Next: report the results.");
    }
    if (++normal === 1) return { stop: "tool_use", content: [reasoning, toolUse("a", "echo", {}), toolUse("b", "echo", {})] };
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]!.content).toContain(original);
    expect(request.messages[0]!.content).toContain("Both commands completed successfully.");
    expect(paired(request.messages)).toBe(true);
    expect(budget(deps, request.messages) + outputCap(deps)).toBeLessThanOrEqual(8000);
    return end("Done.");
  } };
  await createAgent(deps).run();
  expect(executions).toBe(2); expect(normal).toBe(2); expect(summaries).toBe(1);
  const history = transcript.history!().filter(e => e.type !== "model-request");
  expect(history).toHaveLength(4);
  expect(history[2]).toMatchObject({ type: "message", message: { content: [result("a", output), result("b", output)] } });
  expect(await open(transcript.path).chain()).toEqual(await transcript.chain());
});

for (const incomplete of [true, false]) test(`${incomplete ? "missing" : "duplicate"} results refuse compaction before inference and preserve history`, async () => {
  const { deps, transcript, append } = await fixture();
  await append([
    { role: "assistant", content: [reasoning, toolUse("a", "echo", {}), toolUse("b", "echo", {})] },
    { role: "user", content: incomplete ? [result("a", "x".repeat(50000))] : [result("a", "x".repeat(50000)), result("a", "duplicate"), result("b", "ok")] },
  ]);
  const bytes = await Bun.file(transcript.path).text(), head = transcript.head();
  let calls = 0;
  deps.provider = { name: "anthropic", models: async () => [], complete: async () => { calls++; return end("summary"); } };
  expect(await compact(deps, true)).toBe(false);
  expect(calls).toBe(0); expect(transcript.head()).toBe(head);
  expect(await Bun.file(transcript.path).text()).toBe(bytes);
});
