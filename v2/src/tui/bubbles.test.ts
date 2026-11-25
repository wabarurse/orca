import { expect, test } from "bun:test";
import { join } from "node:path";
import { createBubble, joinBubble, readBubble } from "../core/bubbles";
import { createConversation, readConversation } from "../core/conversations";
import { tempHome } from "../test/home";
import { bubbleChoices, bubbleEntries } from "./bubbles";

const home = tempHome("tui-bubbles");

test("the picker offers the folder's bubbles first, then every other bubble labelled with its folder, and joining one from another folder keeps its folder", async () => {
  const a = join(home.path(), "a"), b = join(home.path(), "b");
  const inB = await createConversation(b, null);
  const other = await createBubble(inB.id, "zebra");
  const inA = await createConversation(a, null);
  const own = await createBubble(inA.id, "yak");
  if (!other.ok || !own.ok) throw new Error("bubbles not created");
  const { entries } = await bubbleEntries(join(a, "sub"));
  expect(entries.map(e => [e.bubble.name, e.here])).toEqual([["yak", true], ["zebra", false]]);
  const { options, choices } = await bubbleChoices(a);
  expect(options[1]?.startsWith("yak")).toBe(true);
  expect(options[2]?.startsWith("zebra")).toBe(true);
  expect(options[2]?.endsWith(b)).toBe(true);
  expect(choices[2]).toEqual({ kind: "join", id: other.data.id });
  const fresh = await createConversation(a, null);
  expect((await joinBubble(fresh.id, other.data.id)).ok).toBe(true);
  expect((await readConversation(fresh.id))?.bubble).toBe(other.data.id);
  expect((await readBubble(other.data.id))?.directory).toBe(b);
});
