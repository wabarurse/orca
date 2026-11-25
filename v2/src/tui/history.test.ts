import { expect, test } from "bun:test";
import type { Entry } from "../core/types";
import { browsing, newer, older, onRecalled, sinceClear } from "./history";

const at = (text: string) => ({ text, cursor: text.length, anchor: null });

test("Up recalls older entries, Down newer ones, and Down past the newest restores the draft", () => {
  let b = browsing(["first", "/model", "third"]);
  const draft = { text: "half typed", cursor: 4, anchor: null };
  const one = older(b, draft);
  expect(one?.state).toEqual(at("third"));
  b = one?.browse ?? b;
  const two = older(b, at("third"));
  expect(two?.state).toEqual(at("/model"));
  b = two?.browse ?? b;
  const three = older(b, at("/model"));
  expect(three?.state).toEqual(at("first"));
  b = three?.browse ?? b;
  expect(older(b, at("first"))).toBeNull();
  b = newer(b)?.browse ?? b;
  b = newer(b)?.browse ?? b;
  const back = newer(b);
  expect(back?.state).toEqual(draft);
  expect(back?.browse.at).toBeNull();
  expect(newer(back?.browse ?? b)).toBeNull();
});

test("with no history or not browsing, the arrows do nothing; a recalled entry is recognised until it is edited", () => {
  expect(older(browsing([]), at("x"))).toBeNull();
  expect(newer(browsing(["a"]))).toBeNull();
  const step = older(browsing(["a\nb"]), at(""));
  expect(step).not.toBeNull();
  if (step === null) return;
  expect(onRecalled(step.browse, step.state)).toBe(true);
  expect(onRecalled(step.browse, at("a\nbc"))).toBe(false);
});

test("a cleared view shows only the entries after the one that was last at the clear", () => {
  const entry = (uuid: string): Entry => ({ type: "replies", uuid, parent: null, ts: "", messages: [] });
  const all = [entry("a"), entry("b"), entry("c")];
  expect(sinceClear(all, null)).toEqual(all);
  expect(sinceClear(all, "b").map(e => e.uuid)).toEqual(["c"]);
  expect(sinceClear(all, "c")).toEqual([]);
  expect(sinceClear(all, "gone")).toEqual(all);
});
