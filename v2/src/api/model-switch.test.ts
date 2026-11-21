import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { anthropic } from "./anthropic";
import { toResponses } from "./openai";
import { z } from "zod";

const sse = [
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const sentRequest = z.object({ model: z.string(), messages: z.array(z.unknown()) });
type SentRequest = z.infer<typeof sentRequest>;

function recordingClient(requests: SentRequest[]): Anthropic {
  return new Anthropic({ apiKey: "test-only", baseURL: "https://api.anthropic.test", fetch: async (input, init) => {
    const body: unknown = await (input instanceof Request ? new Request(input, init) : new Request(String(input), init)).json();
    requests.push(sentRequest.parse(body));
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  } });
}

test("cross-provider history preserves text and paired tool IDs but not foreign reasoning", async () => {
  const messages: MessageParam[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "private", signature: JSON.stringify({ provider: "codex", id: "rs_1", encrypted_content: "encrypted" }) },
      { type: "text", text: "context" },
      { type: "tool_use", id: "call_123", name: "echo", input: { text: "hello" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_123", content: "result" }] },
  ];
  const requests: SentRequest[] = [];
  await anthropic(recordingClient(requests)).complete({ model: "claude-test", messages, tools: [], maxTokens: 100, onText() {} });
  const sent = requests[0]?.messages;
  expect(JSON.stringify(sent)).not.toContain("encrypted");
  expect(JSON.stringify(sent)).toContain("context");
  expect(JSON.stringify(sent)).toContain("call_123");
  expect(JSON.stringify(sent)).toContain("result");
  expect(JSON.stringify(messages)).toContain("encrypted");
  const claude: MessageParam[] = [{ role: "assistant", content: [
    { type: "thinking", thinking: "private", signature: "claude-signature" },
    { type: "text", text: "context" },
    { type: "tool_use", id: "toolu_123", name: "echo", input: {} },
  ] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "result" }] }];
  const converted = toResponses(claude);
  expect(JSON.stringify(converted)).not.toContain("claude-signature");
  expect(converted).toContainEqual({ type: "function_call", call_id: "toolu_123", name: "echo", arguments: "{}" });
  expect(converted).toContainEqual({ type: "function_call_output", call_id: "toolu_123", output: "result" });
});

import { claudeMessages } from "./anthropic";
import { fromResponses } from "./openai";

test("actual Codex adapter output roundtrips mixed text/caller/multiple error tool pairs", () => {
  const content = fromResponses([
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "secret" },
    { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "working", annotations: [], logprobs: [] }] },
    { type: "function_call", call_id: "call_a", name: "echo", arguments: '{"text":"a"}', status: "completed" },
    { type: "function_call", call_id: "call_b", name: "echo", arguments: '{"text":"b"}', status: "completed" },
  ]);
  const history: MessageParam[] = [{ role: "assistant", content }, { role: "user", content: [
    { type: "tool_result", tool_use_id: "call_a", content: "success" },
    { type: "tool_result", tool_use_id: "call_b", content: "failure", is_error: true },
  ] }];
  const claude = claudeMessages(history);
  expect(claude[0]?.content).toContainEqual({ type: "tool_use", id: "call_a", name: "echo", input: { text: "a" }, caller: { type: "direct" } });
  expect(JSON.stringify(claude)).not.toContain("secret");
  const roundtrip = toResponses(claude);
  expect(roundtrip).toContainEqual({ type: "function_call_output", call_id: "call_a", output: "success" });
  expect(roundtrip).toContainEqual({ type: "function_call_output", call_id: "call_b", output: "Error: failure" });
  expect(roundtrip).toContainEqual({ type: "function_call", call_id: "call_b", name: "echo", arguments: '{"text":"b"}' });
  expect(JSON.stringify(roundtrip)).toContain("working");
  expect(JSON.stringify(history)).toContain("secret");
});

test("reasoning-only foreign messages dropped; Claude signed/redacted reasoning preserved across Claude models", async () => {
  const reasoning = fromResponses([{ type: "reasoning", id: "rs_only", summary: [], encrypted_content: "secret" }]);
  const history: MessageParam[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: reasoning },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Claude plan", signature: "claude-signed" },
      { type: "redacted_thinking", data: "opaque-claude-data" },
      { type: "text", text: "response" },
    ] },
  ];
  const sanitized = claudeMessages(history);
  expect(sanitized).toHaveLength(2);
  expect(sanitized[1]).toEqual(history[2]);
  const codex = toResponses(history);
  expect(JSON.stringify(codex)).not.toContain("claude-signed");
  expect(JSON.stringify(codex)).not.toContain("opaque-claude-data");
  expect(codex).toContainEqual({ type: "reasoning", id: "rs_only", summary: [], encrypted_content: "secret" });
  const requests: SentRequest[] = [];
  const client = recordingClient(requests);
  for (const model of ["claude-sonnet-4-6", "claude-opus-5-5"]) {
    await anthropic(client).complete({ model, messages: history, tools: [], maxTokens: 100, onText() {} });
  }
  expect(requests).toHaveLength(2);
  expect(requests[0]?.messages).toEqual(requests[1]?.messages);
});

test("an empty Codex reply reaches Claude as nothing: blank text is never recorded or sent (the Messages API refuses it)", async () => {
  const reply = fromResponses([{ type: "reasoning", id: "rs_e", summary: [], encrypted_content: "secret" },
    { type: "message", id: "msg_e", role: "assistant", status: "completed", content: [{ type: "output_text", text: "", annotations: [] }] }]);
  expect(reply.map(b => b.type)).toEqual(["thinking"]);
  const history: MessageParam[] = [{ role: "user", content: "task" }, { role: "assistant", content: [...reply, { type: "text", text: "" }] },
    { role: "user", content: "again" }, { role: "assistant", content: [{ type: "text", text: " \n" }, { type: "text", text: "kept" }] }];
  expect(claudeMessages(history)).toEqual([{ role: "user", content: "task" }, { role: "user", content: "again" }, { role: "assistant", content: [{ type: "text", text: "kept" }] }]);
});

test("a history ending in a reply that never came (reasoning only) is not sent as a prefill; blank Claude text never reaches Codex", async () => {
  const history: MessageParam[] = [{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "text", text: "on it" }] },
    { role: "user", content: [] }, { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "claude-signed" }] }];
  expect(claudeMessages(history)).toEqual(history.slice(0, 2));
  const codex = toResponses([{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "text", text: "" }, { type: "text", text: "kept" }] }]);
  expect(codex.filter(item => "role" in item && item.role === "assistant")).toHaveLength(1);
});
