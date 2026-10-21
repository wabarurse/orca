import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { anthropic } from "./anthropic";
import { toResponses } from "./openai";

// Exercise adapter boundaries without credentials, HTTP or server-side state.
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
  let sent: MessageParam[] = [];
  const client = { messages: { stream(req: { messages: MessageParam[] }) {
    sent = req.messages;
    return { on() {}, async finalMessage() { return { content: [], stop_reason: "end_turn" }; } };
  } } } as unknown as Anthropic;
  await anthropic(client).complete({ model: "claude-test", messages, tools: [], maxTokens: 100, onText() {} });
  expect(JSON.stringify(sent)).not.toContain("encrypted");
  expect(JSON.stringify(sent)).toContain("context");
  expect(JSON.stringify(sent)).toContain("call_123");
  expect(JSON.stringify(sent)).toContain("result");
  expect(JSON.stringify(messages)).toContain("encrypted"); // disk/memory history unchanged
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
  expect(claude[0]!.content).toContainEqual({ type: "tool_use", id: "call_a", name: "echo", input: { text: "a" }, caller: { type: "direct" } });
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
  expect(sanitized[1]).toEqual(history[2]!);
  const codex = toResponses(history);
  expect(JSON.stringify(codex)).not.toContain("claude-signed");
  expect(JSON.stringify(codex)).not.toContain("opaque-claude-data");
  expect(codex).toContainEqual({ type: "reasoning", id: "rs_only", summary: [], encrypted_content: "secret" });
  const requests: { model: string; messages: MessageParam[] }[] = [];
  const client = { messages: { stream(req: { model: string; messages: MessageParam[] }) {
    requests.push(req); return { on() {}, async finalMessage() { return { content: [], stop_reason: "end_turn" }; } };
  } } } as unknown as Anthropic;
  for (const model of ["claude-sonnet-4-6", "claude-opus-5-5"]) {
    await anthropic(client).complete({ model, messages: history, tools: [], maxTokens: 100, onText() {} });
  }
  expect(requests[0]!.messages).toEqual(requests[1]!.messages);
  // This is a preservation assertion, NOT a claim signatures are accepted by
  // every Claude model. Only the service can validate historic signed thinking.
});
