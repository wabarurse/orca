import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../config";
import { tempHome } from "../../test/home";
import { bubblesFor, listBubbles, setBubbleDirectory } from "./store";

const home = tempHome("bubble-store");

test("a bubble written before folders still reads (with no folder, offered nowhere); pointed at a folder it serves that folder and the ones inside it", async () => {
  mkdirSync(join(paths.bubbles, "bubble-0000000a"), { recursive: true });
  writeFileSync(join(paths.bubbles, "bubble-0000000a", "bubble.json"), JSON.stringify({ id: "bubble-0000000a", name: "raven", createdAt: "2026-11-17T17:13:41.091Z", plugins: { on: [], off: [] } }));
  expect((await listBubbles()).map(b => [b.name, b.directory])).toEqual([["raven", null]]);
  const repo = join(home.path(), "raven");
  expect(await bubblesFor(repo)).toEqual([]);
  expect((await setBubbleDirectory("bubble-0000000a", repo)).ok).toBe(true);
  expect((await bubblesFor(repo)).map(b => b.name)).toEqual(["raven"]);
  expect((await bubblesFor(join(repo, "apps", "web"))).map(b => b.name)).toEqual(["raven"]);
  expect(await bubblesFor(`${repo}-fork`)).toEqual([]);
});
