import { bold, dim, fit, headerRow, liveRows, sanitize, wrap, type Frame } from "./render";

export interface StickyScreen {
  rows: string[];
  cols: number;
  cursor: number;
  col: number;
  bodyHeight: number;
  start: number;
  maxStart: number;
}

/** Keep the selected orchestrator visible even when all tabs cannot fit. */
export function tabs(pages: { name: string; busy: boolean }[], active: number, cols: number): string {
  const labels = pages.map((p, i) => i === active ? bold(`[${p.name}]`) : dim(` ${p.name}${p.busy ? " •" : ""} `));
  let start = 0;
  while (start < active && Bun.stringWidth((start ? "‹ " : "") + labels.slice(start, active + 1).join(" ")) > cols) start++;
  return fit(`${start ? "‹ " : ""}${labels.slice(start).join(" ")}`, cols);
}

/** The bars occupy fixed screen rows; only the middle viewport scrolls. */
export function stickyRows(f: Frame, history: string[], chrome: string[], scrollTop: number | null = null): StickyScreen {
  const height = Math.max(1, f.rows);
  const top = chrome.slice(0, Math.min(chrome.length, Math.floor(height / 3), Math.max(0, height - 3))).map(row => headerRow(row, f.cols));
  const bottom = liveRows({ ...f, rows: Math.max(1, height - top.length - 1), partial: "", running: [] });
  const bodyHeight = Math.max(0, height - top.length - bottom.rows.length);
  const partial = f.partial ? f.partial.split("\n").flatMap(line => wrap(sanitize(line), f.cols)) : [];
  const body = [...history, ...partial, ...(f.running ?? [])];
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
