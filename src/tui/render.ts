// Draw one frame of the TUI as a string. Pure: state in, escape codes out.
//
//   ┌ tab bar: one tab per orchestrator page ─────────────┐
//   │ header: the page's clone path and remote             │
//   │ body: the page's scrollback (or a menu over it)      │
//   │ status: a dimmed spinner line while a turn runs      │
//   │ input area: wrapped rows, up to a third of the screen │
//   └──────────────────────────────────────────────────────┘

import { cells, layout, scrollWindow } from "./editor";

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const inverse = (s: string) => `\x1b[7m${s}\x1b[0m`;

/** `spinner` is the busy mark (a spinner frame); "·" when absent. */
export interface Tab { title: string; active: boolean; busy: boolean; spinner?: string }
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

export interface Frame {
  cols: number;
  rows: number;
  tabs: Tab[];
  /** One line under the tabs: where the active page's clone is and came from. */
  header: string;
  /** The active page's scrollback, oldest first. */
  lines: string[];
  /** How many lines up from the bottom the body is scrolled. */
  scroll: number;
  input: Input;
  menu: Menu | null;
  /** A dimmed activity line just above the input (e.g. "⠋ thinking… 3s"), or none. */
  status?: string | null;
  /** `inputArea(input, cols, rows, status ? 1 : 0)` when the caller already has it; computed otherwise. */
  inputArea?: InputArea;
  /** The project list, at the bottom of the body like a menu, when open. */
  projects?: ProjectList | null;
}

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

/** One row: cut with an ellipsis rather than wrapped. */
function fit(raw: string, cols: number): string {
  const line = expandTabs(raw);
  if (visibleLength(line) <= cols) return line;
  return wrap(line, Math.max(1, cols - 1))[0]!.replace(/\x1b\[0m$/, "") + "…\x1b[0m";
}

function tabBar(tabs: Tab[], cols: number): string {
  if (tabs.length === 0) return "";
  const cells = tabs.map((t) => {
    const label = ` ${t.title}${t.busy ? ` ${t.spinner ?? "·"}` : ""} `;
    return t.active ? inverse(label) : dim(label);
  });
  return wrap(cells.join(" "), cols)[0]!;
}

/** The input area as laid out on screen: its rows (prompt on the first, indented after), the cursor within them, and the first text row shown. */
export interface InputArea { lines: string[]; row: number; col: number; top: number }

/** Lay out the input in the bottom of a `rows`-high screen, leaving `reserved` rows (the status line) between it and the body. */
export function inputArea(input: Input, cols: number, rows: number, reserved = 0): InputArea {
  const indent = visibleLength(input.prompt);
  const { rows: all, row, col } = layout(input, cols - indent);
  // At most a third of the screen, less if the tabs, header, reserved rows and a body row would not fit;
  // past that, scroll only when the cursor leaves the window.
  const allowance = Math.max(1, Math.min(Math.floor(rows / 3), rows - 3 - reserved));
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

export function render(f: Frame): string {
  const statusRows = f.status ? 1 : 0;
  const input = f.inputArea ?? inputArea(f.input, f.cols, f.rows, statusRows);
  const bodyRows = Math.max(0, f.rows - 2 - statusRows - input.lines.length);
  const wrapped = f.lines.flatMap((l) => wrap(l, f.cols));
  const end = Math.max(0, wrapped.length - f.scroll);
  const body = wrapped.slice(Math.max(0, end - bodyRows), end);
  while (body.length < bodyRows) body.unshift("");
  // A menu or the project list sits at the bottom of the body, on top of the scrollback.
  const overlay = f.menu
    ? [f.menu.title, ...f.menu.items.map((item, i) => `${i === f.menu!.index ? bold("❯") : " "} ${item}`)].slice(-bodyRows)
    : f.projects ? projectRows(f.projects, bodyRows) : [];
  if (bodyRows) body.splice(body.length - overlay.length, overlay.length, ...overlay.map((r) => fit(r, f.cols)));
  const out: string[] = [tabBar(f.tabs, f.cols), fit(f.header, f.cols), ...body];
  if (f.status) out.push(fit(f.status, f.cols));
  out.push(...input.lines);
  // Clear each row before writing so shorter lines never leave debris.
  const screen = out.map((row, i) => `\x1b[${i + 1};1H\x1b[2K${row}`).join("");
  const row = f.rows - input.lines.length + input.row + 1;
  return `\x1b[?25l${screen}\x1b[${row};${input.col + 1}H\x1b[?25h`;
}
