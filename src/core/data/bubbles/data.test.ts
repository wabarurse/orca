import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config";
import { bubbleDir, dataRoots, ensureBubble, ensureDataDirs, joinBubble } from ".";

// Isolated ORCA_HOME per test: never the real home.
let home: string, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), "orca-data-")); process.env.ORCA_HOME = home;
  for (const project of ["one", "two"]) await mkdir(paths.project(project), { recursive: true });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});

test("a conversation without a bubble gets its data folder and the global link, but no bubble link", async () => {
  const data = await ensureDataDirs("one");
  expect(data).toBe(paths.data("one"));
  expect(await readlink(join(data, "global"))).toBe(paths.globalData);
  expect(existsSync(join(data, "bubble"))).toBe(false);
  expect(existsSync(paths.bubbles)).toBe(false);
  expect(dataRoots("one")).toEqual([paths.data("one"), paths.globalData]);
});

test("the bubble link follows the conversation's bubble", async () => {
  const first = await ensureBubble("one"), second = await ensureBubble("two");
  const data = await ensureDataDirs("one");
  expect(await readlink(join(data, "bubble"))).toBe(join(bubbleDir(first.id), "data"));
  await writeFile(join(data, "bubble", "note.txt"), "shared");
  expect(await readFile(join(bubbleDir(first.id), "data", "note.txt"), "utf8")).toBe("shared");
  await ensureDataDirs("one");
  expect(await readlink(join(data, "bubble"))).toBe(join(bubbleDir(first.id), "data"));
  await joinBubble("one", second.id);
  await ensureDataDirs("one");
  expect(await readlink(join(data, "bubble"))).toBe(join(bubbleDir(second.id), "data"));
  expect(dataRoots("one")).toEqual([paths.data("one"), join(bubbleDir(second.id), "data"), paths.globalData]);
});

test("a real folder under a reserved name is refused, not replaced", async () => {
  await mkdir(join(paths.data("one"), "global", "plugin"), { recursive: true });
  await expect(ensureDataDirs("one")).rejects.toThrow("reserved");
  expect((await lstat(join(paths.data("one"), "global"))).isDirectory()).toBe(true);
});

test("deleting the conversation removes its links without touching what they point at", async () => {
  const bubble = await ensureBubble("one");
  const data = await ensureDataDirs("one");
  await mkdir(join(data, "global", "plugin"), { recursive: true });
  await writeFile(join(data, "global", "plugin", "kept.txt"), "global");
  await writeFile(join(data, "bubble", "kept.txt"), "bubble");
  await rm(paths.project("one"), { recursive: true, force: true });
  expect(existsSync(paths.project("one"))).toBe(false);
  expect(await readFile(join(paths.globalData, "plugin", "kept.txt"), "utf8")).toBe("global");
  expect(await readFile(join(bubbleDir(bubble.id), "data", "kept.txt"), "utf8")).toBe("bubble");
});
