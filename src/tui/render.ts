// Draw the inline TUI as strings. Pure: state in, escape codes out.
//
// Nothing takes over the screen. Finished lines are written once into the
// terminal's own scrollback (`commit`) and never redrawn; only the live region
// at the bottom is (`live`), top to bottom:
//
//   the partial streaming line (until it ends and is committed)
//   a menu or the project list, when open, else the oldest open question
//   the status line: spinner, page name, remote, page count
//   the input area: wrapped rows, up to a third of the screen
//
// The input area and the user's messages (`userRows`) are drawn on the user
// background from style.ts, full width, like Codex's composer and user cells;
// the input gets a padding row above and below in it when the screen has room.
//
// `reprint` clears the screen and scrollback and writes a page from scratch
// (page switches, resizes, agent views).

import { cells, layout, scrollWindow } from "./editor";
import { wordWrap } from "./markdown";
import { fillRow, userFill } from "./style";

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export interface Menu { title: string; items: string[]; index: number }
export interface Input {
  prompt: string;
  text: string;
  cursor: number;
  /** First input row shown last frame, so the window only scrolls when the cursor leaves it; unset shows the end. */
  top?: number;
}
/** One row of the project list: `name` is the id, `label` what it shows. */
export interface ProjectItem { name: string; label: string; pinned: boolean; open: boolean; active: boolean; busy: boolean }
/** The project list (Ctrl+B, /projects): drawn like a menu, with a status and key hint under it. */
export interface ProjectList {
  items: ProjectItem[];
  index: number;
  /** A question or refusal shown under the list, e.g. "delete x? y/n". */
  status: string;
}

/** How the input relates to the shown question: choosing a row, typing its answer, or holding a chat draft (which must go first). */
export type QuestionMode = "pick" | "answer" | "guard";

/** The oldest open question of the active page, as the live region shows it. */
export interface QuestionView {
  text: string;
  options: string[];
  /** The selected row: an option, options.length for "type your own answer", options.length + 1 for "skip". */
  index: number;
  default?: string;
  /** Open questions on the page, this one included. */
  count: number;
  mode: QuestionMode;
}

/** The live region's state. */
export interface Frame {
  cols: number;
  rows: number;
  /** Streamed text not committed yet (a partial line, or a held code block or table, raw); wrapped, above everything else. */
  partial?: string;
  input: Input;
  menu: Menu | null;
  /** The project list, above the status line like a menu, when open. */
  projects?: ProjectList | null;
  /** The question shown above the status line when no menu or project list is open. */
  question?: QuestionView | null;
  /** The status line just above the input (e.g. "⠋ thinking… 3s · name · remote · 2 pages"), or none. */
  status?: string | null;
  /** `inputArea(input, cols, rows, status ? 1 : 0)` when the caller already has it; computed otherwise. */
  inputArea?: InputArea;
}

/** What the last `live` left on screen: its height and the row (from its top) the cursor sits on. */
export interface Shown { height: number; cursor: number }
export const NOTHING: Shown = { height: 0, cursor: 0 };
/** Escape codes that take no columns, as Bun.stringWidth skips them: CSI (with ':' params, as in 38:2:r:g:b) and OSC (hyperlinks, titles). */
const ESCAPE = /^(?:\x1b\[[0-9;:?<>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
/** Display columns, ignoring escape codes; CJK and emoji count two. Expand tabs first. */
export const visibleLength = (s: string) => Bun.stringWidth(s);

/** A styled line as escape codes and the text between them. */
function* tokens(line: string): Generator<{ esc: string } | { text: string }> {
  let i = 0;
  while (i < line.length) {
    const m = line[i] === "\x1b" ? ESCAPE.exec(line.slice(i)) : null;
    if (m) { yield { esc: m[0] }; i += m[0].length; continue; }
    let j = line.indexOf("\x1b", i + 1);
    if (j === -1) j = line.length;
    yield { text: line.slice(i, j) };
    i = j;
  }
}

/**
 * One escape sequence (CSI, OSC, DCS/SOS/PM/APC strings, two-byte ESC
 * sequences, a bare ESC) or one C0/C1 control other than the tab (expanded
 * later): \r, \b, BEL, \v, \f, \n and the rest.
 */
const UNSAFE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -\/]*[0-~])?|[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f]/g;
/** What stays: SGR styling and OSC 8 hyperlinks. */
const KEPT = /^(?:\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))$/;

/**
 * Text that is safe to put on screen: only SGR styling and OSC 8 links stay;
 * every other escape (cursor moves, clears, titles…) and control character
 * goes, so stray tool output cannot move the cursor and break the live
 * region's erase. Split at newlines first: this drops them.
 */
export function sanitize(line: string): string {
  return line.replace(UNSAFE, (m) => (KEPT.test(m) ? m : ""));
}

/** Replace tabs with spaces up to the next 8-column stop (stringWidth counts a tab as nothing). */
export function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let col = 0;
  for (const t of tokens(line)) {
    if ("esc" in t) { out += t.esc; continue; }
    t.text.split("\t").forEach((part, n) => {
      if (n > 0) { const pad = 8 - (col % 8); out += " ".repeat(pad); col += pad; }
      out += part;
      col += Bun.stringWidth(part);
    });
  }
  return out;
}

/** Split a styled line into pieces at most `cols` display columns wide (one wider character may overflow a tiny width). */
export function wrap(line: string, cols: number): string[] {
  if (cols <= 0) return [line];
  const out: string[] = [];
  let piece = "";
  let width = 0;
  for (const t of tokens(expandTabs(line))) {
    if ("esc" in t) { piece += t.esc; continue; }
    for (const c of cells(t.text)) {
      if (width > 0 && width + c.width > cols) { out.push(piece + "\x1b[0m"); piece = ""; width = 0; }
      piece += c.text;
      width += c.width;
    }
  }
  out.push(piece);
  return out;
}

/** A user message line ("> …" or its indented continuation) at `cols`: wrapped, every row on the user background, full width. */
export function userRows(line: string, cols: number): string[] {
  const rows = wrap(sanitize(line), cols);
  const fill = userFill();
  return fill ? rows.map((r) => fillRow(r, cols, fill)) : rows;
}

/** One row: cut with an ellipsis rather than wrapped. */
function fit(raw: string, cols: number): string {
  const line = expandTabs(raw);
  if (visibleLength(line) <= cols) return line;
  return wrap(line, Math.max(1, cols - 1))[0]!.replace(/\x1b\[0m$/, "") + "…\x1b[0m";
}

/** The input area as laid out on screen: its rows (prompt on the first, indented after), the cursor within them, and the first text row shown. */
export interface InputArea { lines: string[]; row: number; col: number; top: number }

/** Lay out the input at the bottom of a `rows`-high screen, leaving `reserved` rows (the status line) above it. */
export function inputArea(input: Input, cols: number, rows: number, reserved = 0): InputArea {
  const indent = visibleLength(input.prompt);
  const { rows: all, row, col } = layout(input, cols - indent);
  // At most a third of the screen, less if the reserved rows and a row above would not fit;
  // past that, scroll only when the cursor leaves the window.
  const allowance = Math.max(1, Math.min(Math.floor(rows / 3), rows - 1 - reserved));
  const shown = Math.min(all.length, allowance);
  const top = scrollWindow(input.top ?? all.length, row, all.length, shown);
  const lines = all.slice(top, top + shown).map((r, i) => (top + i === 0 ? input.prompt : " ".repeat(indent)) + r.text);
  return { lines, row: row - top, col: Math.max(0, Math.min(cols - 1, indent + col)), top };
}

/** First item to show so the selected one stays in a window of `rows`. */
export function windowStart(count: number, index: number, rows: number): number {
  return Math.max(0, Math.min(index - rows + 1, count - rows));
}

function projectRow(it: ProjectItem, selected: boolean): string {
  const mark = `${selected ? bold("❯") : " "} ${it.pinned ? "*" : " "}${it.active ? "●" : it.open ? "○" : " "} `;
  return `${mark}${it.label}${it.busy ? dim(" ·") : ""}`;
}

export const PROJECTS_HINT = "↑↓ Enter opens   p pins   d deletes   Esc closes";

/**
 * The project list's rows, at most `height`: a title, the items (scrolled to
 * keep the selection in view), then the status and key hint. On short
 * terminals the status and hint win over the list.
 */
export function projectRows(p: ProjectList, height: number): string[] {
  const footer = [...(p.status ? p.status.split("\n") : []), dim(PROJECTS_HINT)].slice(0, Math.max(0, height));
  const listRows = Math.max(0, height - footer.length - 1);
  const start = windowStart(p.items.length, p.index, listRows);
  const items = p.items.slice(start, start + listRows).map((it, i) => projectRow(it, start + i === p.index));
  const head = [dim("projects"), ...(p.items.length ? items : [dim("  none yet")])].slice(0, Math.max(0, height - footer.length));
  return [...head, ...footer];
}

export const QUESTION_HINTS: Record<QuestionMode, string> = {
  pick: "↑↓ or 1–9 choose · Enter pick · type to answer · Esc/Tab later",
  answer: "Enter send · Esc clear · Tab later",
  guard: "send or clear your message to answer",
};
export const OWN_ANSWER = "type your own answer";
export const skipRow = (def?: string) => (def ? `skip (use default: ${def})` : "skip");

/** A question's rows: its options numbered (1–9 pick them), then "type your own answer" and "skip". */
export const questionItems = (q: Pick<QuestionView, "options" | "default">): string[] => [...q.options.map((o, i) => `${i + 1}. ${o}`), OWN_ANSWER, skipRow(q.default)];

/**
 * A question's rows, at most `height`, `cols` wide: its text word-wrapped,
 * then its rows (scrolled to keep the selection in view), and the hint for
 * the mode. On short terminals the hint wins, then a row of text, then the rows.
 */
export function questionRows(q: QuestionView, cols: number, height: number): string[] {
  if (height <= 0) return [];
  const footer = [dim(QUESTION_HINTS[q.mode])];
  const room = height - footer.length;
  const items = questionItems(q);
  const head = wordWrap(`${bold("?")} ${q.text}${q.count > 1 ? dim(` (1 of ${q.count})`) : ""}`, cols);
  const textRows = Math.max(0, Math.min(head.length, room > 0 ? Math.max(1, room - items.length) : 0));
  const text = head.slice(0, textRows);
  if (textRows > 0 && textRows < head.length) text[textRows - 1] += "…";
  const listRows = room - text.length;
  const start = windowStart(items.length, q.index, listRows);
  const list = items.slice(start, start + listRows).map((it, i) => `${start + i === q.index ? bold("❯") : " "} ${it}`);
  return [...text, ...list, ...footer];
}

/** A menu's rows, at most `height`: its title, then the items scrolled to keep the selection in view. */
export function menuRows(m: Menu, height: number): string[] {
  const listRows = Math.max(0, height - 1);
  const start = windowStart(m.items.length, m.index, listRows);
  const items = m.items.slice(start, start + listRows).map((item, i) => `${start + i === m.index ? bold("❯") : " "} ${item}`);
  return [m.title, ...items].slice(0, Math.max(0, height));
}

/** Finished lines as they go into the scrollback: split at newlines, wrapped to `cols`, each ending in CRLF. */
export function commit(lines: string[], cols: number): string {
  return lines.flatMap((l) => l.split("\n")).flatMap((l) => wrap(sanitize(l), cols)).map((r) => `${r}\x1b[0m\r\n`).join("");
}

/** The last `n` of `rows` (none when n is 0). */
const lastRows = (rows: string[], n: number) => (n > 0 ? rows.slice(-n) : []);

/** What sits above the status line: a menu, else the project list, else the question. */
function overlayRows(f: Frame, height: number): string[] {
  if (f.menu) return menuRows(f.menu, height);
  if (f.projects) return projectRows(f.projects, height);
  return f.question ? questionRows(f.question, f.cols, height) : [];
}

/** The live region's rows, top to bottom, and where the cursor goes in them. */
export function liveRows(f: Frame): { rows: string[]; cursor: number; col: number } {
  const statusRows = f.status ? 1 : 0;
  const input = f.inputArea ?? inputArea(f.input, f.cols, f.rows, statusRows);
  // Everything must fit on screen, or the cursor could not get back to the top: the overlay
  // gets what the input and status leave (but a row), the partial line the rest, showing its end.
  const fill = userFill();
  // A padding row above and below the input, on its background, when that still leaves a row above.
  const pad = fill && f.rows - statusRows - input.lines.length >= 3 ? 1 : 0;
  const padding = Array<string>(pad).fill("");
  const box = fill ? [...padding, ...input.lines, ...padding].map((r) => fillRow(r, f.cols, fill)) : input.lines;
  let free = Math.max(0, f.rows - statusRows - box.length);
  const overlay = overlayRows(f, free - 1).map((r) => fit(sanitize(r), f.cols));
  free -= overlay.length;
  const partial = f.partial ? lastRows(f.partial.split("\n").flatMap((l) => wrap(sanitize(l), f.cols)), free) : [];
  const rows = [...partial, ...overlay, ...(f.status ? [fit(sanitize(f.status), f.cols)] : []), ...box];
  return { rows, cursor: rows.length - box.length + pad + input.row, col: input.col };
}

/** Move from where `prev` left the cursor to the live region's first row and clear from there down. */
export function erase(prev: Shown): string {
  if (!prev.height) return "";
  return `\r${prev.cursor ? `\x1b[${prev.cursor}A` : ""}\x1b[J`;
}

/**
 * Redraw the live region: erase what `prev` left, write the rows, and put the
 * cursor in the input. Returns the escape codes and what is now shown.
 */
export function live(f: Frame, prev: Shown = NOTHING): { text: string; shown: Shown } {
  const { rows, cursor, col } = liveRows(f);
  const up = rows.length - 1 - cursor;
  const body = rows.map((r) => `${r}\x1b[0m`).join("\r\n");
  const text = `\x1b[?25l${erase(prev)}${body}${up ? `\x1b[${up}A` : ""}\r${col ? `\x1b[${col}C` : ""}\x1b[?25h`;
  return { text, shown: { height: rows.length, cursor } };
}

/** Commit `lines` above the live region: erase it, write them, draw it again. */
export function append(lines: string[], f: Frame, prev: Shown): { text: string; shown: Shown } {
  const next = live(f);
  return { text: `\x1b[?25l${erase(prev)}${commit(lines, f.cols)}${next.text}`, shown: next.shown };
}

/** Clear the screen and the scrollback, then write `lines` and the live region from scratch. */
export const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
export function reprint(lines: string[], f: Frame): { text: string; shown: Shown } {
  const next = live(f);
  return { text: `\x1b[?25l${CLEAR}${commit(lines, f.cols)}${next.text}`, shown: next.shown };
}
