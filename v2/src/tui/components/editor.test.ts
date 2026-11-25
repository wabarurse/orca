import { expect, test } from "bun:test";
import * as editor from "./editor";
import type { Key } from "./keys";

const run = (s: editor.EditState, ...keys: Key[]): editor.EditState => keys.reduce((state, key) => editor.apply(state, key)?.state ?? state, s);
const shown = (s: editor.EditState): string => {
  const sel = editor.selection(s);
  if (sel === null) return `${s.text.slice(0, s.cursor)}|${s.text.slice(s.cursor)}`;
  return `${s.text.slice(0, sel.from)}[${s.text.slice(sel.from, sel.to)}]${s.text.slice(sel.to)}`;
};

test("Option and Ctrl arrows move by word; ESC b / ESC f do the same", () => {
  const s = editor.at("hello big world");
  expect(shown(run(s, { name: "left", alt: true }))).toBe("hello big |world");
  expect(shown(run(s, { name: "left", ctrl: true }, { name: "left", ctrl: true }))).toBe("hello |big world");
  expect(shown(run(s, { name: "b", alt: true }, { name: "b", alt: true }, { name: "f", alt: true }))).toBe("hello big| world");
  expect(shown(run(editor.at("ab cd", 0), { name: "right", ctrl: true }))).toBe("ab| cd");
});

test("Cmd arrows go to line start/end, Cmd Up/Down to the start/end of the message; Ctrl+A/Ctrl+E stay line start/end", () => {
  const s = editor.at("one\ntwo three", 8);
  expect(shown(run(s, { name: "left", cmd: true }))).toBe("one\n|two three");
  expect(shown(run(s, { name: "right", cmd: true }))).toBe("one\ntwo three|");
  expect(shown(run(s, { name: "up", cmd: true }))).toBe("|one\ntwo three");
  expect(shown(run(editor.at("one\ntwo", 1), { name: "down", cmd: true }))).toBe("one\ntwo|");
  expect(shown(run(s, { name: "a", ctrl: true }))).toBe("one\n|two three");
  expect(shown(run(editor.at("one\ntwo", 4), { name: "e", ctrl: true }))).toBe("one\ntwo|");
});

test("word and line deletion: Option+Backspace, Option+Delete, Cmd+Backspace, Fn+Delete, Ctrl+K/U/W", () => {
  const s = editor.at("say hello world", 9);
  expect(shown(run(s, { name: "backspace", alt: true }))).toBe("say | world");
  expect(shown(run(s, { name: "delete", alt: true }))).toBe("say hello|");
  expect(shown(run(s, { name: "d", alt: true }))).toBe("say hello|");
  expect(shown(run(s, { name: "backspace", cmd: true }))).toBe("| world");
  expect(shown(run(s, { name: "delete" }))).toBe("say hello|world");
  expect(shown(run(s, { name: "k", ctrl: true }))).toBe("say hello|");
  expect(shown(run(s, { name: "u", ctrl: true }))).toBe("| world");
  expect(shown(run(s, { name: "w", ctrl: true }))).toBe("say | world");
});

test("Cmd+A selects only the input; typing replaces the selection, Backspace removes it, an arrow collapses it", () => {
  const all = run(editor.at("draft text", 3), { name: "a", cmd: true });
  expect(shown(all)).toBe("[draft text]");
  expect(shown(run(all, { name: "char", text: "x" }))).toBe("x|");
  expect(shown(run(all, { name: "backspace" }))).toBe("|");
  expect(shown(run(all, { name: "delete" }))).toBe("|");
  expect(shown(run(all, { name: "left" }))).toBe("|draft text");
  expect(shown(run(all, { name: "right" }))).toBe("draft text|");
  expect(shown(run(all, { name: "paste", text: "new" }))).toBe("new|");
  expect(editor.selection(run(editor.at(""), { name: "a", cmd: true }))).toBeNull();
});

test("Shift extends by character, Shift+Option by word, Shift+Cmd to the line edge; reversing shrinks it", () => {
  const s = editor.at("alpha beta gamma", 6);
  expect(shown(run(s, { name: "right", shift: true }, { name: "right", shift: true }))).toBe("alpha [be]ta gamma");
  expect(shown(run(s, { name: "right", shift: true, alt: true }))).toBe("alpha [beta] gamma");
  expect(shown(run(s, { name: "right", shift: true, cmd: true }))).toBe("alpha [beta gamma]");
  expect(shown(run(s, { name: "left", shift: true, cmd: true }))).toBe("[alpha ]beta gamma");
  expect(shown(run(s, { name: "right", shift: true }, { name: "left", shift: true }))).toBe("alpha |beta gamma");
  expect(shown(run(s, { name: "right", shift: true, alt: true }, { name: "left", alt: true }))).toBe("|alpha beta gamma");
});

test("wide and emoji graphemes move, delete and wrap as one cell group", () => {
  const s = editor.at("a👩‍👩‍👧b日本");
  expect(shown(run(s, { name: "left" }, { name: "left" }, { name: "left" }))).toBe("a👩‍👩‍👧|b日本");
  expect(shown(run(editor.at("a👩‍👩‍👧b", 9), { name: "backspace" }))).toBe("a|b");
  expect(editor.layout(editor.at("日本語"), 4).rows.map(r => r.text)).toEqual(["日本", "語"]);
});

test("vertical keeps the goal column, Shift+Up/Down extend to the start or end at the edge", () => {
  const s = editor.at("long line\nab\nlong line", 7);
  const down = editor.vertical(s, 40, 1, null);
  expect(down?.cursor).toBe(12);
  const again = down === null ? null : editor.vertical(down, 40, 1, 7);
  expect(again?.cursor).toBe(20);
  expect(editor.vertical(s, 40, -1)).toBeNull();
  expect(shown(editor.extendVertical(s, 40, -1))).toBe("[long li]ne\nab\nlong line");
});

test("a click maps to an offset; a double-click word and a triple-click line", () => {
  const s = editor.at("first line\nsecond");
  expect(editor.hit(s, 40, 1, 3)).toBe(14);
  expect(editor.hit(s, 40, 0, 99)).toBe(10);
  expect(editor.hit(s, 40, -1, 0)).toBe(0);
  expect(editor.hit(s, 40, 5, 0)).toBe(s.text.length);
  expect(editor.wordAt("say hello world", 6)).toEqual({ from: 4, to: 9 });
  expect(editor.lineAt("first line\nsecond", 13)).toEqual({ from: 11, to: 17 });
});

test("keys that are not editing keys are left to the caller", () => {
  const s = editor.at("x");
  expect(editor.apply(s, { name: "tab" })).toBeNull();
  expect(editor.apply(s, { name: "enter" })).toBeNull();
  expect(editor.apply(s, { name: "up" })).toBeNull();
  expect(editor.apply(s, { name: "n", ctrl: true })).toBeNull();
});

test("Ctrl+Shift+A and Option+A select all too, for terminals that keep Cmd+A for themselves", () => {
  const s = editor.at("draft text", 2);
  expect(shown(run(s, { name: "a", ctrl: true, shift: true }))).toBe("[draft text]");
  expect(shown(run(s, { name: "a", alt: true }))).toBe("[draft text]");
});
