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

test("Claude payload uses output_config.effort and speed, adds beta only to preview fast models", async () => {
  const requests: { body: Record<string, unknown>; options?: { headers?: Record<string, string> } }[] = [];
  const client = { messages: { stream(body: Record<string, unknown>, options?: { headers?: Record<string, string> }) {
    requests.push({ body, options }); return { on() {}, async finalMessage() { return { content: [], stop_reason: "end_turn" }; } };
  } } } as unknown as Anthropic;
  for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
    await anthropic(client).complete({ model, messages: [{ role: "user", content: "task" }], tools: [], maxTokens: 100, onText() {}, settings: { effort: "high", fast: true } });
  }
  expect(requests[0]!.body.output_config).toEqual({ effort: "high" });
  expect(requests[0]!.body.speed).toBe("fast");
  expect(requests[0]!.body.service_tier).toBeUndefined();
  expect(requests[0]!.options?.headers).toBeUndefined();
  expect(requests[1]!.options!.headers!["anthropic-beta"]).toContain("fast-mode-2026-02-01");
  expect(requests[2]!.options!.headers!["anthropic-beta"]).toContain("oauth");
  expect(claudeRequestSettings("claude-opus-5-5")).toEqual({});
  expect(claudeRequestSettings("claude-opus-5-5", { fast: false })).toEqual({});
  expect(() => claudeRequestSettings("claude-sonnet-4-6", { effort: "xhigh" })).toThrow("unsupported");
});
