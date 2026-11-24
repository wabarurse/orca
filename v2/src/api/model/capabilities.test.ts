import { afterEach, expect, test } from "bun:test";
import { claudeCatalogEfforts, clearCatalogEfforts, codexCatalogEfforts, codexCatalogFast, knownEfforts, modelCapabilities, rememberCatalogEfforts, rememberCatalogFast } from "./capabilities";
import { clearCatalogLimits, rememberCatalogLimits } from "./context-window";
import { smallModel } from "./summary-model";

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
