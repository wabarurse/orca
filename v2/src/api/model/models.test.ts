import { afterEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../anthropic";
import { claudeCatalogEfforts, clearCatalogEfforts, codexCatalogEfforts, codexCatalogFast, knownEfforts, modelCapabilities, rememberCatalogEfforts, rememberCatalogFast } from "./capabilities";
import { clearCatalogLimits, contextWindow, modelContextLimit, prefetchContextLimits, rememberCatalogLimits } from "./context-window";
import { smallModel } from "./summary-model";

describe("model capabilities", () => {
  afterEach(clearCatalogLimits);

  test("Codex supported_reasoning_levels become effort levels, new ones like ultra included; junk is ignored", () => {
    expect(codexCatalogEfforts([{ effort: "ultra" }, { effort: "low" }, { effort: "xhigh" }, null, "high", { effort: 3 }, { effort: "Bad Level" }])).toEqual(["low", "xhigh", "ultra"]);
    expect(codexCatalogEfforts(undefined)).toEqual([]);
    expect(codexCatalogEfforts("low")).toEqual([]);
  });

  test("Claude capabilities.effort lists levels in canonical order only when supported", () => {
    const flag = (supported: boolean) => ({ supported });
    expect(claudeCatalogEfforts({ effort: { supported: true, max: flag(true), low: flag(true), medium: flag(false), high: flag(true), xhigh: null } })).toEqual(["low", "high", "max"]);
    expect(claudeCatalogEfforts({ effort: { supported: false, low: flag(true), medium: flag(true), high: flag(true), max: flag(true), xhigh: flag(true) } })).toEqual([]);
    expect(claudeCatalogEfforts(null)).toEqual([]);
    expect(claudeCatalogEfforts({})).toEqual([]);
  });

  test("catalog levels replace the built-in table per model; empty or invalid reports keep the fallback", () => {
    expect(modelCapabilities("gpt-5.5").effort).toEqual(["low", "medium", "high", "xhigh"]);
    expect(modelCapabilities("gpt-new").effort).toEqual([]);
    rememberCatalogEfforts([["gpt-5.5", ["medium", "high"]], ["gpt-new", ["low", "Not A Level", 3, "max"]], ["gpt-6-astra", []], ["claude-opus-5", "high"]]);
    expect(modelCapabilities("gpt-5.5")).toEqual({ effort: ["medium", "high"], fast: true });
    expect(modelCapabilities("gpt-new")).toEqual({ effort: ["low", "max"], fast: false });
    expect(modelCapabilities("gpt-6-astra").effort).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelCapabilities("claude-opus-5").effort).toEqual(["low", "medium", "high", "xhigh", "max"]);
    clearCatalogEfforts();
    expect(modelCapabilities("gpt-5.5").effort).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("a level the provider adds is offered and accepted without a table edit", () => {
    rememberCatalogEfforts([["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]]]);
    expect(modelCapabilities("gpt-5.6-terra").effort.at(-1)).toBe("ultra");
    expect(knownEfforts("gpt-5.6-terra")).toContain("ultra");
  });

  test("Codex speed tiers decide fast mode; a catalog without them keeps the table", () => {
    expect(codexCatalogFast([], [])).toBe(false);
    expect(codexCatalogFast(["priority"], [])).toBe(true);
    expect(codexCatalogFast(undefined, [{ id: "fast" }])).toBe(true);
    expect(codexCatalogFast(undefined, undefined)).toBe(null);
    expect(modelCapabilities("gpt-5.6-terra").fast).toBe(true);
    rememberCatalogFast([["gpt-5.6-terra", false], ["gpt-new", true], ["gpt-other", null]]);
    expect(modelCapabilities("gpt-5.6-terra").fast).toBe(false);
    expect(modelCapabilities("gpt-new").fast).toBe(true);
    expect(modelCapabilities("gpt-other").fast).toBe(false);
  });

  test("the small summary model is one the account's catalog offers", () => {
    expect(smallModel("openai")).toBe("gpt-6-luna");
    rememberCatalogLimits([["gpt-5.6-terra", 272000], ["gpt-5.6-luna", 272000]]);
    expect(smallModel("openai")).toBe("gpt-5.6-luna");
    rememberCatalogLimits([["claude-haiku-5-5", 1000000]]);
    expect(smallModel("anthropic")).toBe("claude-haiku-5-5");
  });
});

describe("context windows", () => {
  test("claude standard windows: documented 1M defaults, 200k where 1M is opt-in or absent", () => {
    for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5-2", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) expect(modelContextLimit(m)).toBe(1000000);
    for (const m of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-6-20260301"]) expect(modelContextLimit(m)).toBe(200000);
    for (const m of ["claude-opus-4-6[1m]", "claude-3-opus-20240229", "claude-opus-4-20250514", "unknown", ""]) expect(modelContextLimit(m)).toBeUndefined();
    expect(modelContextLimit("gpt-5.5")).toBe(272000);
  });

  test("context window: explicit budget, verified model, then estimated fallback", () => {
    expect(contextWindow({}, "claude-opus-5-5")).toEqual({ limit: 1000000, estimated: false });
    expect(contextWindow({}, "claude-fable-5-2")).toEqual({ limit: 1000000, estimated: false });
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

  test("prefetch is background, cached once per provider, and falls back silently on failure", async () => {
    let calls = 0;
    const failing = { name: "openai", async models(): Promise<string[]> { calls++; throw new Error("offline"); } };
    void prefetchContextLimits(failing).catch(() => {});
    expect(contextWindow({ fallback: 64000 }, "gpt-new")).toEqual({ limit: 64000, estimated: true });
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(contextWindow({ fallback: 64000 }, "gpt-new")).toEqual({ limit: 64000, estimated: true });
    const release = Promise.withResolvers<void>();
    const working = { name: "openai", models: () => { calls++; return release.promise.then(() => { rememberCatalogLimits([["gpt-new", 300000]]); return ["gpt-new"]; }); } };
    void prefetchContextLimits(working).catch(() => {});
    void prefetchContextLimits(working).catch(() => {});
    await Bun.sleep(0);
    expect(calls).toBe(2);
    expect(contextWindow({}, "gpt-new").estimated).toBe(true);
    release.resolve();
    await Bun.sleep(0);
    void prefetchContextLimits(working).catch(() => {});
    expect(calls).toBe(2);
    expect(contextWindow({}, "gpt-new")).toEqual({ limit: 300000, estimated: false });
  });

  test("prefetch returns the shared in-flight fetch and never rejects, so a picker can wait for catalog data", async () => {
    let calls = 0;
    const failing = { name: "openai", async models(): Promise<string[]> { calls++; throw new Error("offline"); } };
    await prefetchContextLimits(failing);
    await prefetchContextLimits(failing);
    expect(calls).toBe(2);
    const release = Promise.withResolvers<void>();
    const working = { name: "openai", models: () => { calls++; return release.promise.then(() => { rememberCatalogLimits([["gpt-new", 300000]]); return ["gpt-new"]; }); } };
    const first = prefetchContextLimits(working);
    expect(prefetchContextLimits(working)).toBe(first);
    await Bun.sleep(0);
    release.resolve();
    await first;
    expect(calls).toBe(3);
    expect(contextWindow({}, "gpt-new")).toEqual({ limit: 300000, estimated: false });
  });
});
