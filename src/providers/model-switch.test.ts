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
