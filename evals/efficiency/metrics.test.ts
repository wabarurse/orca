import { expect, test } from "bun:test";
import { claudeMetrics, codexMetrics } from "./metrics";
test("Claude includes cache creation and hits in context; split message events are not double counted", () => {
  const message = { id: "m1", usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 200 }, content: [{ type: "tool_use", name: "Read" }] };
  const result = claudeMetrics([{ type: "assistant", message }, { type: "assistant", message }, { type: "result", result: "OK", usage: { ...message.usage, output_tokens: 5 }, modelUsage: { opus: {} } }]);
  expect(result.inputTokens).toBe(302); expect(result.peakInputTokens).toBe(302); expect(result.requests).toBe(1); expect(result.calls).toBe(1);
});
test("Codex total input already includes cached tokens; unavailable peak stays null", () => {
  const result = codexMetrics([{ type: "item.completed", item: { type: "agent_message", text: "OK" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 } }]);
  expect(result.cacheWriteInputTokens).toBeNull(); expect(result.reasoningTokens).toBeNull();
  expect(result.inputTokens).toBe(100); expect(result.cachedInputTokens).toBe(80); expect(result.peakInputTokens).toBeNull(); expect(result.answer).toBe("OK");
});
test("missing terminal events fail rather than silently passing", () => {
  expect(claudeMetrics([]).error).toBeTruthy(); expect(codexMetrics([]).error).toBeTruthy();
});
test("Claude keeps every tool block when separate events share a message id", () => {
  const usage = { input_tokens: 8, output_tokens: 20 };
  const result = claudeMetrics([
    { type: "assistant", message: { id: "same", usage, content: [{ type: "tool_use", id: "one", name: "Read" }] } },
    { type: "assistant", message: { id: "same", usage, content: [{ type: "tool_use", id: "two", name: "Grep" }] } },
    { type: "result", result: "OK", usage, modelUsage: { opus: {} } },
  ]);
  expect(result.requests).toBe(1); expect(result.calls).toBe(2); expect(result.tools).toEqual(["Read", "Grep"]);
});
