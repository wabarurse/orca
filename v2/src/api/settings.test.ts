import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, claudeRequestSettings } from "./anthropic";
import { codexRequestSettings } from "./openai";

test("Codex explicit effort and Fast map independently to reasoning.effort and service_tier priority", () => {
  expect(codexRequestSettings("gpt-6-astra")).toEqual({ reasoning: { summary: "auto" } });
  expect(codexRequestSettings("gpt-6-astra", { effort: "max", fast: true })).toEqual({ reasoning: { summary: "auto", effort: "max" }, service_tier: "priority" });
  expect(codexRequestSettings("gpt-6-astra", { fast: true })).toEqual({ reasoning: { summary: "auto" }, service_tier: "priority" });
  expect(codexRequestSettings("gpt-6-astra", { effort: "low", fast: false })).toEqual({ reasoning: { summary: "auto", effort: "low" } });
  expect(() => codexRequestSettings("unknown", { fast: true })).toThrow("unsupported");
});

const events = [
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];
const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

test("Claude payload uses output_config.effort and speed, adds beta only to preview fast models", async () => {
  const requests: { body: unknown; headers: Headers }[] = [];
  const client = new Anthropic({ apiKey: "test-only", baseURL: "https://api.anthropic.test", fetch: async (input, init) => {
    const request = (input instanceof Request ? new Request(input, init) : new Request(String(input), init));
    const body: unknown = await request.json();
    requests.push({ body, headers: request.headers });
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  } });
  for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
    await anthropic(client).complete({ model, messages: [{ role: "user", content: "task" }], tools: [], maxTokens: 100, onText() {}, settings: { effort: "high", fast: true } });
  }
  const [first, second, third] = requests;
  expect(first?.body).toHaveProperty("output_config", { effort: "high" });
  expect(first?.body).toHaveProperty("speed", "fast");
  expect(first?.body).not.toHaveProperty("service_tier");
  expect(first?.headers.get("anthropic-beta")).toBeNull();
  expect(second?.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
  expect(third?.headers.get("anthropic-beta")).toContain("oauth");
  expect(claudeRequestSettings("claude-opus-5-5")).toEqual({});
  expect(claudeRequestSettings("claude-opus-5-5", { fast: false })).toEqual({});
  expect(() => claudeRequestSettings("claude-sonnet-4-6", { effort: "xhigh" })).toThrow("unsupported");
});
