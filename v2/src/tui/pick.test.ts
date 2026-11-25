import { describe, expect, test } from "bun:test";
import { pickHint, pickKey, pickRows, pickStart, type PickState } from "./pick";
import { renderWork } from "./work";

const plain = (rows: string[]): string[] => rows.map(r => Bun.stripANSI(r));
const char = (text: string) => ({ name: "char", text });
const moved = (state: PickState, ...keys: { name: string; text?: string }[]): PickState => keys.reduce((s, key) => {
  const step = pickKey(s, key);
  return step.kind === "move" ? step.state : s;
}, state);

describe("pick", () => {
  test("every option is drawn; the highlighted one carries ❯ and is inverted, the current one ●, digits number them", () => {
    const state = pickStart("which db?", ["postgres", "sqlite", "Other…", "skip"], { current: 1, digits: true });
    expect(state.index).toBe(1);
    const rows = pickRows(state, 60, 10);
    expect(plain(rows)).toEqual(["  1   postgres", "❯ 2 ● sqlite", "  3   Other…", "  4   skip"]);
    expect(rows[1]).toContain("\x1b[1;7");
    expect(rows.filter(r => r.includes("\x1b[1;7")).length).toBe(1);
    expect(pickHint(state)).toBe("which db?   ↑↓ enter · 1-4 picks   esc cancels");
  });

  test("without options it starts on the first, with no ● and no digits; an out-of-range current is ignored", () => {
    expect(plain(pickRows(pickStart("t", ["a", "b"], undefined), 40, 10))).toEqual(["❯ a", "  b"]);
    expect(pickStart("t", ["a", "b"], { current: 5 }).current).toBeNull();
  });

  test("j/k and arrows move within bounds; Enter sends the highlighted index, Esc null, a digit picks at once only when allowed", () => {
    const start = pickStart("t", ["a", "b", "c"], { current: 0, digits: true });
    expect(moved(start, char("j"), { name: "down" }, char("j")).index).toBe(2);
    expect(moved(start, char("j"), char("k"), { name: "up" }).index).toBe(0);
    expect(pickKey(moved(start, char("j")), { name: "enter" })).toEqual({ kind: "done", index: 1 });
    expect(pickKey(start, { name: "escape" })).toEqual({ kind: "done", index: null });
    expect(pickKey(start, char("3"))).toEqual({ kind: "done", index: 2 });
    expect(pickKey(start, char("4"))).toEqual({ kind: "ignored" });
    expect(pickKey({ ...start, digits: false }, char("2"))).toEqual({ kind: "ignored" });
  });

  test("a long list scrolls to keep the highlighted row and says where it is", () => {
    const state = moved(pickStart("t", Array.from({ length: 12 }, (_, i) => `o${i}`), undefined), ...Array.from({ length: 9 }, () => char("j")));
    const rows = plain(pickRows(state, 40, 5));
    expect(rows).toEqual(["  o6", "  o7", "  o8", "❯ o9", "10 of 12"]);
  });

  test("the work page shows the picker in its detail pane in place of the details", () => {
    const pick = pickStart("answer q-1: which db?", ["postgres", "sqlite"], { current: 1, digits: true });
    const rows = plain(renderWork({ tabs: [{ id: "questions", title: "Questions", count: 1 }], active: 0, rows: [{ id: "q-1", name: "which db?", status: "open", info: "", tone: "normal" }],
      index: 0, pick, details: [{ title: "Question", lines: ["hidden while picking"] }], detailTop: 0, status: pickHint(pick), error: null }, 70, 16));
    const at = rows.findIndex(r => r === "answer q-1: which db?");
    expect(at).toBeGreaterThan(0);
    expect(rows.slice(at + 1, at + 3)).toEqual(["  1   postgres", "❯ 2 ● sqlite"]);
    expect(rows.join("\n")).not.toContain("hidden while picking");
    expect(rows.at(-1)).toBe("answer q-1: which db?   ↑↓ enter · 1-2 picks   esc cancels");
  });

  test("a long title wraps over up to three rows above the options, which stay visible", () => {
    const pick = pickStart(`${"word ".repeat(40)}end?`, ["yes", "no"], undefined);
    const rows = plain(renderWork({ tabs: [], active: 0, rows: [], index: 0, pick, details: [], detailTop: 0, status: "", error: null }, 40, 16));
    const at = rows.findIndex(r => r.startsWith("❯ yes"));
    expect(rows.slice(at - 3, at).every(r => r.startsWith("word"))).toBe(true);
    expect(rows[at + 1]).toBe("  no");
  });
});
