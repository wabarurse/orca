import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../config";
import { loadHistory, MAX_INPUT_HISTORY, remember, saveHistory } from "./history";

const home = mkdtempSync(join(tmpdir(), "parallels-history-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("remember skips blanks and repeats of the last entry and keeps the newest past the cap", () => {
  expect(remember([], "  \n ")).toEqual([]);
  expect(remember(["a"], "a")).toEqual(["a"]);
  expect(remember(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  const full = Array.from({ length: MAX_INPUT_HISTORY }, (_, i) => `m${i}`);
  const next = remember(full, "new");
  expect(next.length).toBe(MAX_INPUT_HISTORY);
  expect(next[0]).toBe("m1");
  expect(next.at(-1)).toBe("new");
});

test("save and load round-trip multi-line entries atomically; damaged lines are skipped", async () => {
  expect(await loadHistory("p")).toEqual([]);
  await saveHistory("p", ["x"]); // no project folder (deleted): nothing written
  expect(existsSync(paths.project("p"))).toBe(false);
  mkdirSync(paths.project("p"), { recursive: true });
  await saveHistory("p", ["one", "two\nlines"]);
  expect(await loadHistory("p")).toEqual(["one", "two\nlines"]);
  expect(readdirSync(dirname(paths.inputHistory("p"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  writeFileSync(paths.inputHistory("p"), '"ok"\n{broken\n42\n"last"');
  expect(await loadHistory("p")).toEqual(["ok", "last"]);
});
