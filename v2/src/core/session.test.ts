import { expect, test } from "bun:test";
import type { Provider } from "../api";
import { contextWindow, rememberCatalogLimits } from "../api/model";
import { learnContextWindow } from "./session";

const catalog = (models: () => Promise<string[]>): Provider => ({ name: "anthropic", complete: async () => { throw new Error("no model calls here"); }, models });

test("a model missing from the built-in table gets its window from the provider's catalog before a request, not the 128k guess", async () => {
  expect(contextWindow({}, "claude-new-9").limit).toBe(128000);
  let asked = 0;
  const learned = await learnContextWindow("claude-new-9", catalog(async () => { asked++; rememberCatalogLimits([["claude-new-9", 1000000]]); return ["claude-new-9"]; }));
  expect(learned).toBe(true);
  expect(contextWindow({}, "claude-new-9")).toEqual({ limit: 1000000, estimated: false });
  expect(await learnContextWindow("claude-new-9", catalog(async () => { asked++; return []; }))).toBe(false);
  expect(asked).toBe(1);
});

test("Fable 5.2 is known to have a 1M window without asking", () => {
  expect(contextWindow({}, "claude-fable-5-2")).toEqual({ limit: 1000000, estimated: false });
});
