import { headerHeight } from "./chrome";
import { historyRows, type Line } from "./lines";
import { fit, liveRows, sanitize, wrap, type Frame } from "./render";

export interface StickyScreen {
  rows: string[];
  cols: number;
  cursor: number;
  col: number;
  bodyHeight: number;
  start: number;
  maxStart: number;
}

/** Reflow a scrolled-back viewport within the same logical conversation block.
 * Relative wrapped-row position is retained; switching owners still follows tail.
 */
export function reflowAnchor(lines: Line[], oldCols: number, cols: number, top: number): number {
  let before = 0, after = 0;
  for (let i = 0; i < lines.length; i++) {
    const block = [lines[i]!], previous = lines[i - 1];
    const oldHeight = historyRows(block, oldCols, previous).length;
    const newHeight = historyRows(block, cols, previous).length;
    if (top < before + oldHeight) return after + Math.min(newHeight - 1, Math.floor((top - before) * newHeight / oldHeight));
    before += oldHeight;
    after += newHeight;
  }
  return after;
}

/** The bars occupy fixed screen rows; only the middle viewport scrolls. */
export function stickyRows(f: Frame, history: string[], chrome: string[], scrollTop: number | null = null): StickyScreen {
  const height = Math.max(1, f.rows);
  const top = chrome.slice(0, headerHeight(height)).map(row => fit(sanitize(row), f.cols));
  const bottom = liveRows({ ...f, rows: Math.max(1, height - top.length - 1), partial: "", running: [], activity: undefined });
  const bodyHeight = Math.max(0, height - top.length - bottom.rows.length);
  const partial = f.partial ? f.partial.split("\n").flatMap(line => wrap(sanitize(line), f.cols)) : [];
  const body = [...history, ...partial, ...(f.running ?? []), ...(f.activity ? [f.activity] : [])];
  const maxStart = Math.max(0, body.length - bodyHeight);
  const start = scrollTop === null ? maxStart : Math.max(0, Math.min(scrollTop, maxStart));
  const visible = body.slice(start, start + bodyHeight).map(line => fit(sanitize(line), f.cols));
  const padding = Array.from({ length: bodyHeight - visible.length }, () => "");
  return { rows: [...top, ...visible, ...padding, ...bottom.rows], cols: f.cols, cursor: height - bottom.rows.length + bottom.cursor, col: bottom.col, bodyHeight, start, maxStart };
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
