import { headerHeight } from "../header/chrome";
import type { Line } from "../conversation/lines";
import { captureAnchor, resolveAnchor } from "../conversation/anchor";
import { fit, sanitize, wrap } from "../components/text";
import { liveRows, type Frame } from "../footer/render";
import { whaleRows } from "../header/whale";

export interface StickyScreen {
  rows: string[];
  cols: number;
  cursor: number;
  col: number;
  bodyHeight: number;
  bodyTop: number;
  start: number;
  maxStart: number;
}

/** One-shot reflow; App retains the captured content anchor across repeated resizes. */
export function reflowAnchor(lines: Line[], oldCols: number, cols: number, top: number): number {
  return resolveAnchor(lines, cols, captureAnchor(lines, oldCols, top));
}

/** The bars occupy fixed screen rows; only the middle viewport scrolls. */
export function stickyRows(f: Frame, history: string[], chrome: string[], scrollTop: number | null = null): StickyScreen {
  const height = Math.max(1, f.rows);
  const top = chrome.slice(0, headerHeight(height)).map(row => fit(sanitize(row), f.cols));
  const bottom = liveRows({ ...f, rows: Math.max(1, height - top.length - 1), partial: "", running: [], activity: undefined });
  const available = Math.max(0, height - top.length - bottom.rows.length);
  // Reserve a neutral row above the ENTIRE footer, not in history or its tail.
  // Keep footer/editor geometry unchanged; tiny screens and the last body row win.
  const gap = height >= 8 && available >= 2 ? 1 : 0;
  const bodyHeight = available - gap;
  const partial = f.partial ? f.partial.split("\n").flatMap(line => wrap(sanitize(line), f.cols)) : [];
  const tail = [...partial, ...(f.running ?? []), ...(f.activity ? [f.activity] : [])];
  const maxStart = Math.max(0, history.length + tail.length - bodyHeight);
  const start = scrollTop === null ? maxStart : Math.max(0, Math.min(scrollTop, maxStart));
  // Do not copy/visit the complete cached history on every key or activity tick.
  // Slice the viewport across the saved-history / transient-tail boundary only.
  const end = start + bodyHeight;
  const visible = [...history.slice(start, end), ...tail.slice(Math.max(0, start - history.length), Math.max(0, end - history.length))]
    .map(line => fit(sanitize(line), f.cols));
  const padding = Array.from({ length: bodyHeight - visible.length }, () => "");
  if (f.welcome && !history.length && !tail.length) {
    const art = whaleRows(f.cols, bodyHeight);
    const offset = Math.floor((bodyHeight - art.length) / 2);
    art.forEach((row, i) => { padding[offset + i] = row; });
  }
  return { rows: [...top, ...visible, ...padding, ...(gap ? [""] : []), ...bottom.rows], cols: f.cols, cursor: height - bottom.rows.length + bottom.cursor, col: bottom.col, bodyTop: top.length, bodyHeight, start, maxStart };
}

/** Repaint changed rows only, without scrolling either bar or flashing the screen. */
export function stickyUpdate(next: StickyScreen, previous?: StickyScreen): string {
  let output = "";
  for (let row = 0; row < next.rows.length; row++) {
    if (previous?.cols === next.cols && previous.rows.length === next.rows.length && previous.rows[row] === next.rows[row]) continue;
    output += `\x1b[${row + 1};1H\x1b[0m\x1b[2K${next.rows[row]}\x1b[0m`;
  }
  if (!output && previous?.cursor === next.cursor && previous.col === next.col) return "";
  return `\x1b[?25l${output}\x1b[${next.cursor + 1};${next.col + 1}H\x1b[?25h`;
}
