import { afterEach, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { clearCatalogLimits, contextWindow, modelContextLimit, prefetchContextLimits, rememberCatalogLimits } from "./model-context";
import { anthropic } from "./providers/anthropic";
import { contextStatus } from "./tui/context-status";

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
afterEach(clearCatalogLimits);

const claudeCatalog = (data: object[]) => anthropic(new Anthropic({ apiKey: "test", baseURL: "https://api.test",
  fetch: async () => Response.json({ data: data.map((m, i) => ({ type: "model", display_name: "m", created_at: `2026-01-0${i + 1}T00:00:00Z`, ...m })), has_more: false }) }));

test("claude catalog: max_input_tokens fills gaps; null, absent and invalid values are ignored", async () => {
  const ids = await claudeCatalog([{ id: "claude-new", max_input_tokens: 500000 }, { id: "claude-null", max_input_tokens: null },
    { id: "claude-absent" }, { id: "claude-zero", max_input_tokens: 0 }, { id: "claude-neg", max_input_tokens: -5 }, { id: "claude-str", max_input_tokens: "9" }]).models();
  expect(ids).toEqual(["claude-str", "claude-neg", "claude-zero", "claude-absent", "claude-null", "claude-new"]);
  expect(contextWindow({}, "claude-new")).toEqual({ limit: 500000, estimated: false });
  for (const m of ["claude-null", "claude-absent", "claude-zero", "claude-neg", "claude-str"]) expect(contextWindow({}, m)).toEqual({ limit: 128000, estimated: true });
});

test("catalog precedence: explicit > smaller of table and catalog; opt-in 1M never replaces 4.6's 200k", async () => {
  await claudeCatalog([{ id: "claude-opus-4-6", max_input_tokens: 1000000 }, { id: "claude-sonnet-4-6", max_input_tokens: 1000000 },
    { id: "claude-opus-4-6-20260301", max_input_tokens: 1000000 }, { id: "claude-opus-4-7", max_input_tokens: 400000 }]).models();
  for (const m of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-6-20260301"]) expect(modelContextLimit(m)).toBe(200000);
  expect(modelContextLimit("claude-opus-4-7")).toBe(400000);
  expect(modelContextLimit("claude-opus-4-8")).toBe(1000000);
  expect(contextWindow({ contextLimit: 6789 }, "claude-opus-4-7")).toEqual({ limit: 6789, estimated: false });
  rememberCatalogLimits([["gpt-5.5", 400000], ["gpt-new", 300000], ["bad", NaN], ["inf", Infinity]]);
  expect(modelContextLimit("gpt-5.5")).toBe(272000);
  expect(modelContextLimit("gpt-new")).toBe(300000);
  expect(modelContextLimit("bad")).toBeUndefined();
  expect(modelContextLimit("inf")).toBeUndefined();
});

test("header shows a catalog-derived limit without the estimate mark", () => {
  expect(contextStatus("gpt-new", 45000)).toBe("ctx ~45k/128k?");
  rememberCatalogLimits([["gpt-new", 300000]]);
  expect(contextStatus("gpt-new", 45000)).toBe("ctx ~45k/300k");
});

test("prefetch is background, cached once per provider, and falls back silently on failure", async () => {
  let calls = 0;
  const failing = { name: "openai", async models(): Promise<string[]> { calls++; throw new Error("offline"); } };
  prefetchContextLimits(failing);
  expect(contextWindow({ fallback: 64000 }, "gpt-new")).toEqual({ limit: 64000, estimated: true });
  await Bun.sleep(0);
  expect(calls).toBe(1);
  expect(contextWindow({ fallback: 64000 }, "gpt-new")).toEqual({ limit: 64000, estimated: true });
  let resolve!: () => void;
  const working = { name: "openai", models: () => { calls++; return new Promise<string[]>((r) => { resolve = () => { rememberCatalogLimits([["gpt-new", 300000]]); r(["gpt-new"]); }; }); } };
  prefetchContextLimits(working); // A failed fetch may be retried.
  prefetchContextLimits(working); // In flight or done: cached, no second request.
  await Bun.sleep(0);
  expect(calls).toBe(2);
  expect(contextWindow({}, "gpt-new").estimated).toBe(true); // Not blocked on the fetch.
  resolve();
  await Bun.sleep(0);
  prefetchContextLimits(working);
  expect(calls).toBe(2);
  expect(contextWindow({}, "gpt-new")).toEqual({ limit: 300000, estimated: false });
});
