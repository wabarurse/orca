import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../config/config";
import { appendHistory, COMPACT_AT, keepable, loadHistory, MAX_INPUT_HISTORY, remember } from "./history";

const home = mkdtempSync(join(tmpdir(), "orca-history-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

const tmps = (project: string) => readdirSync(dirname(paths.inputHistory(project))).filter((n) => n.endsWith(".tmp"));

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

test("only plain messages and harmless commands are kept; never sign-in or credentials", () => {
  for (const t of ["build it", "/agents", "/model gpt-5", "/help", "/projects", "/review-rounds 2", "/dynamic-dispatch on", "/back", "/close", "/quit", "/keys", "/rename x", "/new demo", "/new demo https://github.com/a/b.git"]) expect(keepable(t, false)).toBe(true);
  for (const t of ["/clear", "/clear secret argument", "/login claude", "/login", "/accounts", "/new demo https://user:TOKEN@github.com/a/b.git", "/new demo https://TOKEN@github.com/a/b", "/new d ssh://git@host/x", "/unknown", "  "]) expect(keepable(t, false)).toBe(false);
  expect(keepable("my message", true)).toBe(false); // typed while signing in
});

test("appends one line per entry, loads the newest, skips damaged lines, and never recreates a deleted project", async () => {
  expect(await loadHistory("p")).toEqual({ entries: [], lines: 0 });
  expect(await appendHistory("p", "x", 0)).toBe(0); // no project folder: nothing written
  expect(existsSync(paths.project("p"))).toBe(false);
  mkdirSync(paths.project("p"), { recursive: true });
  expect(await appendHistory("p", "one", 0)).toBe(1);
  expect(await appendHistory("p", "two\nlines", 1)).toBe(2);
  expect(readFileSync(paths.inputHistory("p"), "utf8")).toBe('"one"\n"two\\nlines"\n');
  expect(await loadHistory("p")).toEqual({ entries: ["one", "two\nlines"], lines: 2 });
  writeFileSync(paths.inputHistory("p"), '"ok"\n{broken\n42\n"last"');
  expect((await loadHistory("p")).entries).toEqual(["ok", "last"]);
});

test("two writers interleave whole entries", async () => {
  mkdirSync(paths.project("two"), { recursive: true });
  await Promise.all(Array.from({ length: 50 }, (_, i) => appendHistory("two", `w${i % 2}-${i}`, i)));
  const { entries } = await loadHistory("two");
  expect(entries.length).toBe(50);
  expect(new Set(entries).size).toBe(50);
});

test("past twice the cap the file is rewritten to the newest entries, atomically; a failed rewrite leaves no temp file", async () => {
  mkdirSync(paths.project("big"), { recursive: true });
  writeFileSync(paths.inputHistory("big"), Array.from({ length: COMPACT_AT - 1 }, (_, i) => JSON.stringify(`m${i}`) + "\n").join(""));
  const loaded = await loadHistory("big");
  expect(loaded.entries.length).toBe(MAX_INPUT_HISTORY); // trimmed on load
  expect(loaded.entries.at(-1)).toBe(`m${COMPACT_AT - 2}`);
  expect(await appendHistory("big", "newest", loaded.lines)).toBe(MAX_INPUT_HISTORY);
  const after = await loadHistory("big");
  expect(after.lines).toBe(MAX_INPUT_HISTORY);
  expect(after.entries.at(-1)).toBe("newest");
  expect(tmps("big")).toEqual([]);

  const rename = spyOn(fsp, "rename").mockRejectedValueOnce(new Error("disk full"));
  try {
    await expect(appendHistory("big", "again", COMPACT_AT)).rejects.toThrow("disk full");
  } finally { rename.mockRestore(); }
  expect(tmps("big")).toEqual([]);
  expect((await loadHistory("big")).entries.at(-1)).toBe("again"); // the append itself landed
});
