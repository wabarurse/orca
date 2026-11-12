// Pure, cell-correct row rendering shared by the pinned screen and terminal tests.
// Production uses sticky.ts: history plus transient activity in the middle,
// a ruled chapter header above, and the boxed composer/counts/panels below.
// The legacy inline helpers remain useful for isolated renderer tests; they do
// not drive the application's terminal lifecycle or conversation viewport.

import { bold, dim, fit, sanitize, visibleLength, wrap } from "../components";
import { fillRow, userFill } from "../components";
import { layout, scrollWindow } from "./editor";

/** Scrollable footer content is already wrapped to the current width; its viewport is transient. */
export interface Help { lines: string[]; top: number; heading?: string }
/** `footer`: rows under the items (a status, a count, a key hint) that win over the list on short terminals. */
export interface Menu { title: string; items: string[]; index: number; footer?: string[] }
export interface Input {
  prompt: string;
  text: string;
  cursor: number;
  mode?: "normal" | "insert";
  /** First input row shown last frame, so the window only scrolls when the cursor leaves it; unset shows the end. */
  top?: number;
}
/** How the input relates to the shown question: choosing a row or typing its answer, with the chat draft saved separately. */
export type QuestionMode = "pick" | "answer";

/** The question whose answer form is open on the Questions page, as the controller sees it. */
export interface QuestionView {
  text: string;
  options: string[];
  /** The controller's row: an option, options.length for a typed answer, options.length + 1 for skip. */
  index: number;
  default?: string;
  /** Open questions on the page, this one included. */
  count: number;
  position?: number;
  mode: QuestionMode;
}

/** A read-only projection of submitted input, never a delivery queue or a draft. */
export interface QueuedInput { project: string; texts: readonly string[] }

/** The live region's state. */
export interface Frame {
  cols: number;
  rows: number;
  /** Streamed text not committed yet (a partial line, or a held code block or table, raw); wrapped, above everything else. */
  partial?: string;
  /** Rows of the tool calls running now (tools.ts, already styled), under the partial line. */
  running?: string[];
  /** Transient selected-conversation activity; never persisted or part of the footer. */
  activity?: string;
  /** Decorative new-chat art in the empty viewport; never history or model context. */
  welcome?: boolean;
  input: Input;
  /** The selected project's orchestrator inbox/sign-in-held input, oldest first (even in an agent view). */
  queued?: QueuedInput;
  menu: Menu | null;
  /** Explicit scrollable help below the composer; never part of the transcript. */
  help?: Help | null;
  /** The open answer form's question (work-page.ts draws it); never drawn in the footer. */
  question?: QuestionView | null;
  /** Grouped counts below the composer, or none. */
  status?: string | null;
  /** Precomputed using the bottom bar's height and packed status rows; computed otherwise. */
  inputArea?: InputArea;
}

/** What the last `live` left on screen: its height and the row (from its top) the cursor sits on. */
export interface Shown { height: number; cursor: number }
export const NOTHING: Shown = { height: 0, cursor: 0 };
/** The input area as laid out on screen: its rows (prompt on the first, indented after), the cursor within them, and the first text row shown. */
export interface InputArea { lines: string[]; row: number; col: number; top: number }

/** The same geometry drives rendering AND vertical editing, including long/clipped prompts. */
export function inputGeometry(prompt: string, cols: number, rows: number): { prompt: string; rail: number; width: number } {
  const rail = cols >= 6 && rows >= 8 ? 1 : 0;
  const inner = Math.max(1, cols - rail * 2);
  const clipped = inner < 4 ? "" : fit(sanitize(prompt), inner - 2);
  return { prompt: clipped, rail, width: inner - visibleLength(clipped) };
}

/** Lay out a boxed composer, dropping its border on tiny screens before sacrificing editable text. */
export function inputArea(input: Input, cols: number, rows: number, reserved = 0): InputArea {
  const { prompt, rail, width } = inputGeometry(input.prompt, cols, rows);
  const mode = input.mode ? `[${input.mode.toUpperCase()}]` : "";
  const label = mode ? cols >= mode.length + 5 ? `─ ${mode} ` : `[${input.mode![0]!.toUpperCase()}]` : "";
  const modeRow = !rail && !!mode && rows >= 3 && rows - reserved >= 2 ? 1 : 0;
  const indent = visibleLength(prompt);
  const { rows: all, row, col } = layout(input, width);
  const allowance = Math.max(1, Math.min(Math.floor(rows / 3), rows - 1 - reserved - rail * 2 - modeRow));
  const shown = Math.min(all.length, allowance);
  const top = scrollWindow(input.top ?? all.length, row, all.length, shown);
  const lines = all.slice(top, top + shown).map((r, i) => {
    const text = fit((top + i === 0 ? prompt : " ".repeat(indent)) + sanitize(r.text), cols - rail * 2);
    return rail ? `${dim("│")}${text}${" ".repeat(Math.max(0, cols - 2 - visibleLength(text)))}${dim("│")}` : text;
  });
  if (rail) { lines.unshift(dim("┌" + label + "─".repeat(cols - 2 - label.length) + "┐")); lines.push(dim("└" + "─".repeat(cols - 2) + "┘")); }
  else if (modeRow) lines.unshift(dim(fit(mode, cols)));
  return { lines, row: row - top + rail + modeRow, col: Math.max(0, Math.min(cols - rail - 1, rail + indent + col)), top };
}

/** Pack the three count groups, stacking at narrow widths; on tiny screens input and tail win. */
export function statusRows(status: string | null | undefined, cols: number, rows: number): string[] {
  if (!status || rows < 3) return [];
  const separator = status.includes(" | ") ? " | " : " │ ";
  const groups = sanitize(status).split(separator);
  const out: string[] = [];
  for (const group of groups) {
    const last = out.at(-1);
    if (last && visibleLength(last + separator + group) <= cols) out[out.length - 1] = last + separator + group;
    else out.push(fit(group, cols));
  }
  return out.slice(0, Math.max(0, rows - 2)).map(dim);
}

/** First item to show so the selected one stays in a window of `rows`. */
export function windowStart(count: number, index: number, rows: number): number {
  return Math.max(0, Math.min(index - rows + 1, count - rows));
}

/** A menu's rows, at most `height`: its title, then the items scrolled to keep the selection in view, then its footer. */
export function menuRows(m: Menu, height: number): string[] {
  const footer = (m.footer ?? []).slice(0, Math.max(0, height - 1));
  const listRows = Math.max(0, height - 1 - footer.length);
  const start = windowStart(m.items.length, m.index, listRows);
  const items = m.items.slice(start, start + listRows).map((item, i) => `${start + i === m.index ? bold("❯") : " "} ${item}`);
  return [m.title, ...items, ...footer].slice(0, Math.max(0, height));
}

/** Finished lines as they go into the scrollback: split at newlines, wrapped to `cols`, each ending in CRLF. */
export function commit(lines: string[], cols: number): string {
  return lines.flatMap((l) => l.split("\n")).flatMap((l) => wrap(sanitize(l), cols)).map((r) => `${r}\x1b[0m\r\n`).join("");
}

/** The last `n` of `rows` (none when n is 0). */
const lastRows = (rows: string[], n: number) => (n > 0 ? rows.slice(-n) : []);

/** Plain previews cannot inject terminal controls or borrow styling from the prompt. */
const preview = (text: string) => Bun.stripANSI(sanitize(text.replace(/\r\n?|\n/g, " ↵ ")));

/**
 * Oldest first, one cell-clipped preview per prompt. The heading's shown/total
 * ratio survives narrow widths; ellipses mark clipped text and ↵ marks newlines.
 * A one-row budget folds the first preview into the label, rather than becoming
 * only a count. At truly tiny sizes the composer/status take precedence.
 */
export function queuedRows(queue: QueuedInput | undefined, cols: number, height: number): string[] {
  if (!queue?.texts.length || height <= 0) return [];
  const shown = Math.min(queue.texts.length, Math.max(1, height - 1));
  const count = `${shown}/${queue.texts.length}`;
  if (height === 1) return [dim(fit(`queued ${count} · orch: ${preview(queue.texts[0]!)}`, cols))];
  const hidden = queue.texts.length - shown;
  const title = `queued ${count} · ${cols < 48 ? "orch" : "orchestrator"}${hidden ? ` · ${hidden} hidden` : ""} · ${preview(queue.project)}`;
  return [dim(fit(title, cols)), ...queue.texts.slice(0, shown).map((text, i) => dim(fit(`  ${i + 1}. ${preview(text)}`, cols)))];
}

/** Share the queue budget with help's scrolling geometry; never shrink/reflow the editor for previews. */
function footerBase(f: Frame): { status: string[]; input: InputArea; queued: string[]; free: number } {
  const status = statusRows(f.status, f.cols, f.rows);
  const input = f.inputArea ?? inputArea(f.input, f.cols, f.rows, status.length);
  const available = Math.max(0, f.rows - input.lines.length - status.length);
  // stickyRows already reserves one conversation row. Leave two more for content
  // and its separator when possible; cap previews at six rows / a third of the footer.
  const height = Math.min(6, Math.floor(f.rows / 3), Math.max(0, available - 2));
  const queued = queuedRows(f.queued, f.cols, height);
  return { status, input, queued, free: available - queued.length };
}

/** Help leaves conversation space even on ordinary 24-row terminals. Input/status win on tiny screens. */
export function helpPanel(f: Frame): { rows: string[]; top: number; bodyHeight: number; maxTop: number } {
  return scrollPanel(f, f.help, "help · commands & keys", "help");
}

function scrollPanel(f: Frame, view: Help | null | undefined, title: string, shortTitle: string): ReturnType<typeof helpPanel> {
  const { free } = footerBase(f);
  // stickyRows already reserves one body row; leave two more for content and its separator.
  const height = Math.min(free, 18, Math.max(1, Math.floor(f.rows * 0.65)), Math.max(1, free - 2));
  const lines = view?.lines ?? [];
  const headingRows = view?.heading && height >= 4 ? [view.heading] : [];
  const bodyHeight = Math.max(0, height - 2 - headingRows.length);
  const maxTop = Math.max(0, lines.length - Math.max(1, bodyHeight));
  const top = Math.max(0, Math.min(view?.top ?? 0, maxTop));
  if (!view || height <= 0) return { rows: [], top, bodyHeight, maxTop };
  const range = bodyHeight ? `${top + 1}–${Math.min(lines.length, top + bodyHeight)}/${lines.length}` : "";
  title = f.cols >= 48 ? title : shortTitle;
  const gap = f.cols - visibleLength(title) - visibleLength(range) - 2;
  const heading = bold(title) + (gap > 0 && range ? " ".repeat(gap) + dim(range) : "");
  const hint = f.cols >= 58 ? "↑↓ / wheel scroll · pgup/pgdn · home/end · esc close" : f.cols >= 24 ? "↑↓ scroll · esc close" : "esc close · ↑↓";
  // Even when only one panel row fits, dismissal stays discoverable. If no
  // rows fit the help key layer still owns keys, like other hidden modals.
  const rows = height === 1 ? [dim("esc close help")] : [heading, ...headingRows, ...lines.slice(top, top + bodyHeight), dim(hint)];
  return { rows: rows.map(row => fit(row, f.cols)), top, bodyHeight, maxTop };
}

/** What sits below input/status: a menu or help. Lists and questions have their own full page. */
function overlayRows(f: Frame, height: number): string[] {
  if (f.menu) return menuRows(f.menu, height);
  return f.help ? helpPanel(f).rows : [];
}

/** Queued previews immediately ABOVE input; counts/panels below. Input and status win on tiny screens. */
export function liveRows(f: Frame): { rows: string[]; cursor: number; col: number } {
  const { status, input, queued, free } = footerBase(f);
  const panel = overlayRows(f, free).map((r) => fit(sanitize(r), f.cols));
  const streamed = f.partial ? f.partial.split("\n").flatMap((l) => wrap(sanitize(l), f.cols)) : [];
  const above = lastRows([...streamed, ...(f.running ?? []).map((r) => fit(sanitize(r), f.cols)), ...(f.activity ? [fit(sanitize(f.activity), f.cols)] : [])], free - panel.length);
  const band = [...queued, ...input.lines, ...status, ...panel];
  const fill = userFill();
  const rows = [...above, ...band.map((r) => fill ? fillRow(r, f.cols, fill) : r)];
  return { rows, cursor: above.length + queued.length + input.row, col: input.col };
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
