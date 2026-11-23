import { expect, test } from "bun:test";
import { contextLine } from "./app";

test("the header's third row shows how much of the model's context the conversation uses", () => {
  expect(contextLine(45_300, "claude-opus-5-5")).toBe(" · ctx 45k/1M");
  expect(contextLine(512, "gpt-6-astra")).toBe(" · ctx 512/272k");
  expect(contextLine(1_250_000, "claude-opus-5-5")).toBe(" · ctx 1.3M/1M");
  expect(contextLine(null, "claude-opus-5-5")).toBe(" · ctx -/1M");
  expect(contextLine(9_000, "some-unknown-model")).toBe(" · ctx 9k/~128k");
});
