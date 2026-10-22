import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import type { CompleteRequest } from "./index";

function client() {
  const sent: any[] = [];
  return { sent, sdk: { messages: { stream(body: unknown) {
    sent.push(body); return { on() {}, async finalMessage() { return {
      stop_reason: "end_turn", content: [{ type: "text", text: "OK" }],
      usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 },
    }; } };
  } } } as unknown as Anthropic };
}
const request: CompleteRequest = { model: "claude-opus-5-5", system: "Stable instructions", maxTokens: 100,
  settings: { effort: "medium", fast: false }, tools: [], onText() {},
  messages: [{ role: "user", content: "Original task" }, { role: "assistant", content: [{ type: "tool_use", id: "call", name: "bash", input: { command: "pwd" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "workspace" }] }],
};
test("opt-in automatic caching changes only the cache directive, not tools, history, or generation settings", async () => {
  const normal = client(), cached = client();
  const original = structuredClone(request.messages);
  await anthropic(normal.sdk).complete(request);
  await anthropic(cached.sdk, { promptCache: true }).complete(request);
  expect(normal.sent[0].cache_control).toBeUndefined();
  expect(cached.sent[0]).toEqual({ ...normal.sent[0], cache_control: { type: "ephemeral" } });
  expect(request.messages).toEqual(original);
});
test("cache reads and writes still count in input context, with writes tracked separately", async () => {
  const { sdk } = client();
  const turn = await anthropic(sdk, { promptCache: true }).complete(request);
  expect(turn.inputTokens).toBe(1103);
  expect(turn.usage).toEqual({ input: 1103, cachedInput: 1000, cacheWriteInput: 100, output: 5 });
});
test("a replaced compacted history is sent as-is, without retaining a stale manual cache breakpoint", async () => {
  const { sdk, sent } = client(); const p = anthropic(sdk, { promptCache: true });
  await p.complete(request);
  const messages: CompleteRequest["messages"] = [{ role: "user", content: "Summary of prior work" }, { role: "user", content: "Continue the remaining work" }];
  await p.complete({ ...request, messages });
  expect(sent[1].messages).toEqual(messages);
  expect(sent[1].system).toEqual(sent[0].system);
  expect(sent[1].cache_control).toEqual({ type: "ephemeral" });
});
