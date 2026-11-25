import { expect, test } from "bun:test";
import { tempHome } from "../test/home";
import { INPUT_HISTORY_LIMIT, readInputHistory, recordInput, remember } from "./input-history";

tempHome("input-history");

test("remember skips consecutive duplicates and blank input, and keeps only the newest entries", () => {
  expect(remember(["a"], "a")).toEqual(["a"]);
  expect(remember(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  expect(remember(["a"], "  ")).toEqual(["a"]);
  expect(remember(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
});

test("input history persists per conversation, bounded", async () => {
  expect(await readInputHistory("c-00000001")).toEqual([]);
  await recordInput("c-00000001", "hello");
  await recordInput("c-00000001", "/clear-chat");
  await recordInput("c-00000001", "/clear-chat");
  expect(await readInputHistory("c-00000001")).toEqual(["hello", "/clear-chat"]);
  expect(await readInputHistory("c-00000002")).toEqual([]);
  for (let i = 0; i < INPUT_HISTORY_LIMIT + 5; i++) await recordInput("c-00000003", `m${i}`);
  const kept = await readInputHistory("c-00000003");
  expect(kept.length).toBe(INPUT_HISTORY_LIMIT);
  expect(kept.at(-1)).toBe(`m${INPUT_HISTORY_LIMIT + 4}`);
});
