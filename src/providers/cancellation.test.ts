import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";

// Exercise the actual SDK's HTTP/stream abort path, not a provider that merely
// stops emitting text. No subscription credentials or external network needed.
test("Claude cancellation disconnects an in-progress HTTP stream", async () => {
  let disconnected = false;
  const events = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
  ];
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")));
    }, cancel() { disconnected = true; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const abort = new AbortController();
    const provider = anthropic(new Anthropic({ apiKey: "test-only", baseURL: server.url.toString(), maxRetries: 0 }));
    const result = provider.complete({ model: "claude-test", tools: [], messages: [{ role: "user", content: "hi" }], maxTokens: 100, signal: abort.signal,
      onText() { abort.abort(); },
    });
    await expect(result).rejects.toThrow();
    const deadline = Date.now() + 2000;
    while (!disconnected && Date.now() < deadline) await Bun.sleep(5);
    expect(disconnected).toBe(true);
  } finally { await server.stop(true); }
});
