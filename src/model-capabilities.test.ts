import { afterEach, expect, test } from "bun:test";
import { claudeCatalogEfforts, clearCatalogEfforts, codexCatalogEfforts, modelCapabilities, rememberCatalogEfforts } from "./model-capabilities";

afterEach(clearCatalogEfforts);

test("Codex supported_reasoning_levels become known effort levels; junk is ignored", () => {
  expect(codexCatalogEfforts([{ effort: "low" }, { effort: "xhigh" }, { effort: "ultra" }, null, "high", { effort: 3 }])).toEqual(["low", "xhigh"]);
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
  rememberCatalogEfforts([["gpt-5.5", ["medium", "high"]], ["gpt-new", ["low", "bogus", "max"]], ["gpt-6-astra", []], ["claude-opus-5", "high"]]);
  expect(modelCapabilities("gpt-5.5")).toEqual({ effort: ["medium", "high"], fast: true });
  expect(modelCapabilities("gpt-new")).toEqual({ effort: ["low", "max"], fast: false });
  expect(modelCapabilities("gpt-6-astra").effort).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(modelCapabilities("claude-opus-5").effort).toEqual(["low", "medium", "high", "xhigh", "max"]);
  clearCatalogEfforts();
  expect(modelCapabilities("gpt-5.5").effort).toEqual(["low", "medium", "high", "xhigh"]);
});
