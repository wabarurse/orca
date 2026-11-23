import { cells } from "./text";

const ESCAPE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-9;:?<>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const BARE_URL = /https?:\/\/[^\s<>"'`\x1b]+/g;
export const OPENABLE = /^(?:https?:\/\/|mailto:)\S+$/i;

export type LinkSpan = { url: string; start: number; end: number };

type Piece = { kind: "escape"; text: string; link: string | null | undefined } | { kind: "cell"; text: string; x: number; width: number };

function pieces(row: string): Piece[] {
  const out: Piece[] = [];
  let x = 0, i = 0;
  while (i < row.length) {
    ESCAPE.lastIndex = i;
    const m = row[i] === "\x1b" ? ESCAPE.exec(row) : null;
    if (m !== null) { out.push({ kind: "escape", text: m[0], link: m[1] === undefined ? undefined : m[1] === "" ? null : m[1] }); i += m[0].length; continue; }
    let j = row.indexOf("\x1b", i + 1);
    if (j === -1) j = row.length;
    for (const c of cells(row, i, j)) { out.push({ kind: "cell", text: c.text, x, width: c.width }); x += c.width; }
    i = j;
  }
  return out;
}

function osc8Spans(row: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  let open: { url: string; start: number } | null = null, x = 0;
  for (const piece of pieces(row)) {
    if (piece.kind === "cell") { x = piece.x + piece.width; continue; }
    if (piece.link === undefined) continue;
    if (open !== null) spans.push({ url: open.url, start: open.start, end: x });
    open = piece.link === null ? null : { url: piece.link, start: x };
  }
  if (open !== null) spans.push({ url: open.url, start: open.start, end: x });
  return spans.filter(s => s.end > s.start && OPENABLE.test(s.url));
}

function bareSpans(plain: string): LinkSpan[] {
  return [...plain.matchAll(BARE_URL)].map(m => {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, ""), start = Bun.stringWidth(plain.slice(0, m.index));
    return { url, start, end: start + Bun.stringWidth(url) };
  });
}

export function linkSpanAt(row: string, col: number): LinkSpan | undefined {
  const inside = (s: LinkSpan): boolean => col >= s.start && col < s.end;
  return osc8Spans(row).find(inside) ?? bareSpans(Bun.stripANSI(row)).find(inside);
}

export function linkAt(row: string, col: number): string | undefined {
  return linkSpanAt(row, col)?.url;
}

export function underlineSpan(row: string, span: LinkSpan): string {
  let out = "", inside = false;
  for (const piece of pieces(row)) {
    if (piece.kind === "escape") { out += piece.text; if (inside && piece.text.startsWith("\x1b[")) out += "\x1b[4m"; continue; }
    const within = piece.x >= span.start && piece.x < span.end;
    if (within && !inside) { out += "\x1b[4m"; inside = true; }
    if (!within && inside) { out += "\x1b[24m"; inside = false; }
    out += piece.text;
  }
  return inside ? `${out}\x1b[24m` : out;
}
