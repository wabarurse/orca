import { expect, test } from "bun:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { toChat, toChatTools } from "./openai";
import { providerFor } from "./index";

test("providerFor routes claude models to anthropic and the rest to openai", () => {
  expect(providerFor("claude-opus-5-5")).toBe("anthropic");
  expect(providerFor("gpt-5")).toBe("openai");
});

test("toChat translates the Anthropic-shaped transcript to chat completions", () => {
  const messages: MessageParam[] = [
    { role: "user", content: "run ls" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "" },
        { type: "text", text: "ok" },
        { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.ts", is_error: true }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  expect(toChat(messages)).toEqual([
    { role: "user", content: "run ls" },
    { role: "assistant", content: "ok", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "Error: a.ts" },
    { role: "assistant", content: "done" },
  ]);
});

test("toChatTools wraps our tool specs as function tools", () => {
  const schema = { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] };
  expect(toChatTools([{ name: "bash", description: "run", input_schema: schema }])).toEqual([
    { type: "function", function: { name: "bash", description: "run", parameters: schema } },
  ]);
});
