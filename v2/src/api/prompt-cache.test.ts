import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropic } from "./anthropic";
import type { CompleteRequest } from "./provider";

const events = [
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];
const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const sentBody = z.object({ system: z.array(z.record(z.string(), z.unknown())), messages: z.unknown(), cache_control: z.unknown().optional() }).loose();

function client() {
  const sent: unknown[] = [];
  const sdk = new Anthropic({ apiKey: "test-only", baseURL: "https://api.anthropic.test", fetch: async (input, init) => {
    const body: unknown = await (input instanceof Request ? new Request(input, init) : new Request(String(input), init)).json();
    sent.push(body);
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  } });
  return { sent, sdk };
}
const body = (sent: unknown[], index: number) => sentBody.parse(sent[index]);
const request: CompleteRequest = { model: "claude-opus-5-5", system: "Stable instructions", maxTokens: 100,
  settings: { effort: "medium", fast: false }, tools: [], onText() {},
  messages: [{ role: "user", content: "Original task" }, { role: "assistant", content: [{ type: "tool_use", id: "call", name: "bash", input: { command: "pwd" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "workspace" }] }],
};
test("opt-in caching adds stable-prefix and moving history boundaries without changing history or generation settings", async () => {
  const normal = client(), cached = client();
  const original = structuredClone(request.messages);
  await anthropic(normal.sdk).complete(request);
  await anthropic(cached.sdk, { promptCache: true }).complete(request);
  const plain = body(normal.sent, 0);
  expect(plain.cache_control).toBeUndefined();
  expect(body(cached.sent, 0)).toEqual({ ...plain, cache_control: { type: "ephemeral" },
    system: plain.system.map((block, i) => i === 1 ? { ...block, cache_control: { type: "ephemeral" } } : block) });
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
  expect(body(sent, 1).messages).toEqual(messages);
  expect(body(sent, 1).system).toEqual(body(sent, 0).system);
  expect(body(sent, 1).cache_control).toEqual({ type: "ephemeral" });
});

test("local cache-routing scope and trace never enter Anthropic model payloads", async () => {
  const { sdk, sent } = client(), p = anthropic(sdk, { promptCache: true });
  await p.complete({ ...request, cacheScope: "/local/one", trace: { run: "one" } });
  await p.complete({ ...request, cacheScope: "/local/two", trace: { run: "two" } });
  expect(sent[1]).toEqual(sent[0]); expect(JSON.stringify(sent)).not.toContain("/local/");
});
