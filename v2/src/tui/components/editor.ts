import type { Key } from "./keys";
import { cells } from "./text";

export type EditState = { text: string; cursor: number; anchor: number | null };
export type Span = { from: number; to: number };
export type EditKind = "move" | "type" | "space" | "delete-back" | "delete-forward" | "other";
export type Edit = { state: EditState; kind: EditKind };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const isWord = (g: string) => /[\p{L}\p{N}_]/u.test(g);
const isSpace = (g: string) => /^\s+$/u.test(g);

const prev = (text: string, i: number) => cells(text, 0, i).at(-1)?.at ?? 0;
function next(text: string, i: number): number {
  for (const { segment } of segmenter.segment(text.slice(i))) return i + segment.length;
  return text.length;
}

const lineStart = (text: string, i: number) => text.lastIndexOf("\n", i - 1) + 1;
function lineEnd(text: string, i: number): number {
  const n = text.indexOf("\n", i);
  return n === -1 ? text.length : n;
}
const textStart = (): number => 0;
const textEnd = (text: string): number => text.length;

export const at = (text: string, cursor = text.length): EditState => ({ text, cursor: Math.max(0, Math.min(cursor, text.length)), anchor: null });

export function selection(s: EditState): Span | null {
  if (s.anchor === null || s.anchor === s.cursor) return null;
  return { from: Math.min(s.anchor, s.cursor), to: Math.max(s.anchor, s.cursor) };
}

export function selectedText(s: EditState): string {
  const sel = selection(s);
  return sel === null ? "" : s.text.slice(sel.from, sel.to);
}

function replace(s: EditState, from: number, to: number, insert = ""): EditState {
  return { text: s.text.slice(0, from) + insert + s.text.slice(to), cursor: from + insert.length, anchor: null };
}

function removing(s: EditState, range: (text: string, i: number) => Span): EditState {
  const sel = selection(s);
  if (sel !== null) return replace(s, sel.from, sel.to);
  const r = range(s.text, s.cursor);
  return replace(s, r.from, r.to);
}

type Motion = (text: string, i: number) => number;

function move(s: EditState, motion: Motion, dir: -1 | 1, extend: boolean): EditState {
  if (extend) return { ...s, cursor: motion(s.text, s.cursor), anchor: s.anchor ?? s.cursor };
  const sel = selection(s);
  if (sel === null) return { ...s, cursor: motion(s.text, s.cursor), anchor: null };
  return { ...s, cursor: dir === -1 ? sel.from : sel.to, anchor: null };
}

function moveFromEdge(s: EditState, motion: Motion, dir: -1 | 1, extend: boolean): EditState {
  const sel = selection(s);
  if (extend || sel === null) return move(s, motion, dir, extend);
  return { ...s, cursor: motion(s.text, dir === -1 ? sel.from : sel.to), anchor: null };
}

export const insert = (s: EditState, text: string): EditState => {
  const sel = selection(s);
  return sel === null ? replace(s, s.cursor, s.cursor, text) : replace(s, sel.from, sel.to, text);
};
export const newline = (s: EditState) => insert(s, "\n");
export const backspace = (s: EditState) => removing(s, (t, i) => ({ from: prev(t, i), to: i }));
export const deleteForward = (s: EditState) => removing(s, (t, i) => ({ from: i, to: next(t, i) }));
export const cut = (s: EditState) => removing(s, (_t, i) => ({ from: i, to: i }));
export const left = (s: EditState, extend = false) => move(s, prev, -1, extend);
export const right = (s: EditState, extend = false) => move(s, next, 1, extend);
export const home = (s: EditState, extend = false) => moveFromEdge(s, lineStart, -1, extend);
export const end = (s: EditState, extend = false) => moveFromEdge(s, lineEnd, 1, extend);
export const start = (s: EditState, extend = false) => moveFromEdge(s, textStart, -1, extend);
export const finish = (s: EditState, extend = false) => moveFromEdge(s, textEnd, 1, extend);
export const killToStart = (s: EditState) => removing(s, (t, i) => ({ from: lineStart(t, i), to: i }));
export const killToEnd = (s: EditState) => removing(s, (t, i) => ({ from: i, to: lineEnd(t, i) }));
export const selectAll = (s: EditState): EditState => s.text.length === 0 ? { ...s, anchor: null } : { text: s.text, cursor: s.text.length, anchor: 0 };
export function collapse(s: EditState, dir: -1 | 1): EditState {
  const sel = selection(s);
  return { ...s, cursor: sel === null ? s.cursor : dir === -1 ? sel.from : sel.to, anchor: null };
}
export const select = (s: EditState, span: Span, cursorAtEnd = true): EditState =>
  ({ ...s, anchor: cursorAtEnd ? span.from : span.to, cursor: cursorAtEnd ? span.to : span.from });

function back(text: string, i: number, inWord: (g: string) => boolean): number {
  const cs = cells(text, 0, i);
  let k = cs.length;
  const word = (at: number): boolean => inWord(cs[at]?.text ?? "");
  while (k > 0 && !word(k - 1)) k--;
  while (k > 0 && word(k - 1)) k--;
  return cs[k]?.at ?? i;
}
function forward(text: string, i: number, inWord: (g: string) => boolean): number {
  const cs = cells(text, i);
  let k = 0;
  const word = (at: number): boolean => inWord(cs[at]?.text ?? "");
  while (k < cs.length && !word(k)) k++;
  while (k < cs.length && word(k)) k++;
  return cs[k]?.at ?? text.length;
}

export const wordBack = (text: string, i: number) => back(text, i, isWord);
export const wordForward = (text: string, i: number) => forward(text, i, isWord);
export const wordLeft = (s: EditState, extend = false) => moveFromEdge(s, wordBack, -1, extend);
export const wordRight = (s: EditState, extend = false) => moveFromEdge(s, wordForward, 1, extend);
export const deleteWordBack = (s: EditState) => removing(s, (t, i) => ({ from: wordBack(t, i), to: i }));
export const deleteWordForward = (s: EditState) => removing(s, (t, i) => ({ from: i, to: wordForward(t, i) }));
export const rubout = (s: EditState) => removing(s, (t, i) => ({ from: back(t, i, (g) => !isSpace(g)), to: i }));

export function wordAt(text: string, i: number): Span {
  const cs = cells(text);
  const k = cs.findIndex(c => c.end > i);
  if (k === -1) return { from: text.length, to: text.length };
  const kind = (g: string): number => isWord(g) ? 0 : isSpace(g) && g !== "\n" ? 1 : 2;
  const own = kind(cs[k]?.text ?? "");
  if (own === 2) return { from: cs[k]?.at ?? i, to: cs[k]?.end ?? i };
  let a = k, b = k;
  while (a > 0 && kind(cs[a - 1]?.text ?? "") === own) a--;
  while (b < cs.length - 1 && kind(cs[b + 1]?.text ?? "") === own) b++;
  return { from: cs[a]?.at ?? i, to: cs[b]?.end ?? i };
}

export const lineAt = (text: string, i: number): Span => ({ from: lineStart(text, i), to: lineEnd(text, i) });

type Action = (s: EditState, extend: boolean) => EditState;
type Bound = { action: Action; kind: EditKind };

const moving = (action: Action): Bound => ({ action, kind: "move" });
const editing = (action: (s: EditState) => EditState, kind: EditKind = "other"): Bound => ({ action: (s) => action(s), kind });

const CTRL: Record<string, Bound> = {
  a: moving(home), e: moving(end), j: editing(newline), u: editing(killToStart), k: editing(killToEnd), w: editing(deleteWordBack),
  d: editing(deleteForward, "delete-forward"),
  left: moving(wordLeft), right: moving(wordRight), home: moving(start), end: moving(finish),
  backspace: editing(deleteWordBack), delete: editing(deleteWordForward),
};
const ALT: Record<string, Bound> = {
  a: { action: selectAll, kind: "move" }, b: moving(wordLeft), f: moving(wordRight), d: editing(deleteWordForward),
  left: moving(wordLeft), right: moving(wordRight), home: moving(home), end: moving(end),
  backspace: editing(deleteWordBack), delete: editing(deleteWordForward),
};
const CMD: Record<string, Bound> = {
  a: { action: selectAll, kind: "move" }, left: moving(home), right: moving(end), up: moving(start), down: moving(finish),
  home: moving(start), end: moving(finish), backspace: editing(killToStart), delete: editing(killToEnd),
};
const PLAIN: Record<string, Bound> = {
  left: moving(left), right: moving(right), home: moving(home), end: moving(end),
  backspace: editing(backspace, "delete-back"), delete: editing(deleteForward, "delete-forward"),
};

const typed = (text: string): EditKind => [...segmenter.segment(text)].length !== 1 ? "other" : isSpace(text) ? "space" : "type";

export function apply(s: EditState, key: Key): Edit | null {
  if (key.name === "char") return { state: insert(s, key.text ?? ""), kind: typed(key.text ?? "") };
  if (key.name === "paste") return { state: insert(s, key.text ?? ""), kind: "other" };
  if (key.name === "a" && key.ctrl === true && key.shift === true && key.cmd !== true) return { state: selectAll(s), kind: "move" };
  const table = key.cmd === true ? CMD : key.ctrl === true ? CTRL : key.alt === true ? ALT : PLAIN;
  const bound = Object.hasOwn(table, key.name) ? table[key.name] : undefined;
  return bound === undefined ? null : { state: bound.action(s, key.shift === true), kind: bound.kind };
}

export type Row = { start: number; end: number; text: string };
export type Layout = { rows: Row[]; row: number; col: number };

const row = (text: string, start: number, end: number): Row => ({ start, end, text: text.slice(start, end) });

function wrapLine(text: string, start: number, end: number, width: number): Row[] {
  const out: Row[] = [];
  let rowStart = start;
  let used = 0;
  for (const c of cells(text, start, end)) {
    if (used > 0 && used + c.width > width) { out.push(row(text, rowStart, c.at)); rowStart = c.at; used = 0; }
    used += c.width;
  }
  out.push(row(text, rowStart, end));
  if (used >= width) out.push(row(text, end, end));
  return out;
}

export function layout(s: EditState, width: number): Layout {
  const w = Math.max(1, width);
  const rows: Row[] = [];
  let start = 0;
  for (const line of s.text.split("\n")) {
    rows.push(...wrapLine(s.text, start, start + line.length, w));
    start += line.length + 1;
  }
  let r = rows.length - 1;
  while (r > 0 && (rows[r]?.start ?? 0) > s.cursor) r--;
  return { rows, row: r, col: Bun.stringWidth(s.text.slice(rows[r]?.start ?? 0, s.cursor)) };
}

function offsetIn(s: EditState, rows: Row[], to: number, col: number): number {
  const target = rows[to];
  if (target === undefined) return s.cursor;
  let i = target.start;
  let used = 0;
  for (const c of cells(s.text, target.start, target.end)) {
    if (used + c.width > col) break;
    used += c.width;
    i = c.end;
  }
  if (i === target.end && i > target.start && rows[to + 1]?.start === i) i = prev(s.text, i);
  return i;
}

export function vertical(s: EditState, width: number, dir: -1 | 1, goal: number | null = null): EditState | null {
  const { rows, row: from, col } = layout(s, width);
  const to = from + dir;
  if (rows[to] === undefined) return null;
  return { ...s, cursor: offsetIn(s, rows, to, goal ?? col) };
}

export function extendVertical(s: EditState, width: number, dir: -1 | 1, goal: number | null = null): EditState {
  const moved = vertical(s, width, dir, goal);
  return { ...s, cursor: moved === null ? (dir === -1 ? 0 : s.text.length) : moved.cursor, anchor: s.anchor ?? s.cursor };
}

export function hit(s: EditState, width: number, rowIndex: number, col: number): number {
  const { rows } = layout(s, width);
  if (rowIndex < 0) return 0;
  if (rowIndex >= rows.length) return s.text.length;
  return offsetIn(s, rows, rowIndex, Math.max(0, col));
}

export function scrollWindow(top: number, row: number, total: number, shown: number): number {
  let t = Math.min(top, row);
  if (row >= t + shown) t = row - shown + 1;
  return Math.max(0, Math.min(t, total - shown));
}
