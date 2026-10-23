import { expect, test } from "bun:test";
import { contextWindow, modelContextLimit } from "./model-context";

test("claude standard windows: documented 1M defaults, 200k where 1M is opt-in or absent", () => {
  for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) expect(modelContextLimit(m)).toBe(1000000);
  for (const m of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]) expect(modelContextLimit(m)).toBe(200000);
  for (const m of ["claude-opus-4-6[1m]", "claude-3-opus-20240229", "claude-opus-4-20250514", "unknown", ""]) expect(modelContextLimit(m)).toBeUndefined();
  expect(modelContextLimit("gpt-5.5")).toBe(272000);
});

test("context window: explicit budget, verified model, then estimated fallback", () => {
  expect(contextWindow({}, "claude-opus-5-5")).toEqual({ limit: 1000000, estimated: false });
  expect(contextWindow({ fallback: 5000 }, "claude-opus-5-5")).toEqual({ limit: 1000000, estimated: false });
  expect(contextWindow({ contextLimit: 6789, fallback: 5000 }, "claude-opus-5-5")).toEqual({ limit: 6789, estimated: false });
  expect(contextWindow({ fallback: 64000 }, "unknown")).toEqual({ limit: 64000, estimated: true });
  expect(contextWindow({}, "unknown")).toEqual({ limit: 128000, estimated: true });
  for (const bad of [NaN, 0, -1, Infinity]) expect(contextWindow({ fallback: bad }, "unknown")).toEqual({ limit: 128000, estimated: true });
  expect(contextWindow({ contextLimit: NaN }, "gpt-5.5")).toEqual({ limit: 128000, estimated: true });
});
