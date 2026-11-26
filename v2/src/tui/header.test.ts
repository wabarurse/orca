import { expect, test } from "bun:test";
import { contextLine } from "./app";

const cases: [number | null, string, string][] = [
  [45_300, "claude-opus-5-5", " · ctx 45k/1M"],
  [512, "gpt-6-astra", " · ctx 512/272k"],
  [1_250_000, "claude-opus-5-5", " · ctx 1.3M/1M"],
  [null, "claude-opus-5-5", " · ctx -/1M"],
  [9_000, "some-unknown-model", " · ctx 9k/~128k"],
];

test.each(cases)("the header's third row shows how much of the model's context the conversation uses: %p tokens of %s", (used, model, shown) => {
  expect(contextLine(used, model)).toBe(shown);
});
