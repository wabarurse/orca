export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export const RESET = "\x1b[0m";
export const linkOpen = (url: string) => `\x1b]8;;${url}\x1b\\`;
export const LINK_CLOSE = "\x1b]8;;\x1b\\";

export type Cell = { at: number; end: number; text: string; width: number };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cells(text: string, start = 0, end = text.length): Cell[] {
  const out: Cell[] = [];
  for (const { segment, index } of segmenter.segment(text.slice(start, end))) {
    out.push({ at: start + index, end: start + index + segment.length, text: segment, width: Bun.stringWidth(segment) });
  }
  return out;
}

const ESCAPE = /^(?:\x1b\[[0-9;:?<>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
export const visibleLength = (s: string) => Bun.stringWidth(s);

function* tokens(line: string): Generator<{ esc: string } | { text: string }> {
  let i = 0;
  while (i < line.length) {
    const m = line[i] === "\x1b" ? ESCAPE.exec(line.slice(i)) : null;
    if (m !== null) { yield { esc: m[0] }; i += m[0].length; continue; }
    let j = line.indexOf("\x1b", i + 1);
    if (j === -1) j = line.length;
    yield { text: line.slice(i, j) };
    i = j;
  }
}

const UNSAFE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -\/]*[0-~])?|[\x00-\x08\x0a-\x1a\x1c-\x1f\x7f-\x9f]/g;
const KEPT = /^(?:\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))$/;

export function sanitize(line: string): string {
  return line.replace(UNSAFE, (m) => (KEPT.test(m) ? m : ""));
}

export function plainText(text: string): string {
  return Bun.stripANSI(sanitize(text.replace(/\r\n?|\n|\t|\u2028|\u2029/g, " ")))
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

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

function continuedStyle(style: string, esc: string): string {
  if (!/^\x1b\[[0-9;:]*m$/.test(esc)) return style;
  return /^\x1b\[(?:0)?m$/.test(esc) ? "" : style + esc;
}

const fittingCell = (c: { text: string; width: number }, cols: number) => c.width > cols ? { text: "…", width: 1 } : c;

export function wrap(line: string, cols: number): string[] {
  if (cols <= 0) return [line];
  const out: string[] = [];
  let piece = "";
  let width = 0;
  let style = "";
  for (const t of tokens(expandTabs(line))) {
    if ("esc" in t) {
      piece += t.esc;
      style = continuedStyle(style, t.esc);
      continue;
    }
    for (const source of cells(t.text)) {
      const c = fittingCell(source, cols);
      if (width > 0 && width + c.width > cols) { out.push(piece + "\x1b[0m"); piece = style; width = 0; }
      piece += c.text;
      width += c.width;
    }
  }
  out.push(piece);
  return out;
}

export function fit(raw: string, cols: number): string {
  if (cols <= 0) return "";
  const line = expandTabs(raw);
  if (visibleLength(line) <= cols) return line;
  if (cols === 1) return "…";
  return (wrap(line, Math.max(1, cols - 1))[0] ?? "").replace(/\x1b\[0m$/, "") + "…\x1b[0m";
}

const ESC = /\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/y;

function* pieces(s: string): Generator<{ esc: string } | { space: number } | { word: string; width: number }> {
  let i = 0;
  while (i < s.length) {
    ESC.lastIndex = i;
    const m = s[i] === "\x1b" ? ESC.exec(s) : null;
    if (m !== null) { yield { esc: m[0] }; i += m[0].length; continue; }
    let j = i + 1;
    while (j < s.length && s[j] !== "\x1b") j++;
    yield* words(s.slice(i, j));
    i = j;
  }
}

function* words(text: string): Generator<{ space: number } | { word: string; width: number }> {
  let word = "";
  let width = 0;
  for (const c of cells(text)) {
    const space = c.text === " ";
    if (word !== "" && (space || c.width > 1)) { yield { word, width }; word = ""; width = 0; }
    if (space) yield { space: 1 };
    else if (c.width > 1) yield { word: c.text, width: c.width };
    else { word += c.text; width += c.width; }
  }
  if (word !== "") yield { word, width };
}

class Pen {
  sgr: string[] = [];
  url = "";
  apply(esc: string): void {
    if (esc.startsWith("\x1b]")) this.url = /^\x1b\]8;[^;]*;([^\x07\x1b]*)/.exec(esc)?.[1] ?? "";
    else if (esc === RESET || esc === "\x1b[m") this.sgr = [];
    else this.sgr.push(esc);
  }
  close(): string { return `${this.url !== "" ? LINK_CLOSE : ""}${this.sgr.length > 0 ? RESET : ""}`; }
  open(): string { return `${this.sgr.join("")}${this.url !== "" ? linkOpen(this.url) : ""}`; }
}

class Filler {
  readonly lines: string[] = [];
  private line = "";
  private used = 0;
  gap = 0;
  private held: string[] = [];
  private readonly pen = new Pen();
  constructor(private readonly w: number) {}

  esc(e: string): void {
    if (this.gap > 0) { this.held.push(e); return; }
    this.line += e;
    this.pen.apply(e);
  }

  word(text: string, tw: number): void {
    if (this.used > 0 && this.used + this.gap + tw > this.w) this.newLine();
    if (this.used > 0) { this.line += " ".repeat(this.gap); this.used += this.gap; }
    this.gap = 0;
    for (const e of this.held.splice(0)) this.esc(e);
    this.line += text;
    this.used += tw;
  }

  long(word: string): void {
    if (this.used > 0) this.newLine();
    for (const c of cells(word)) this.word(c.text, c.width);
  }

  private newLine(): void {
    this.lines.push(this.line + this.pen.close());
    this.line = this.pen.open();
    this.used = 0;
  }

  end(): string[] {
    this.gap = 0;
    for (const e of this.held.splice(0)) this.esc(e);
    this.lines.push(this.line);
    return this.lines;
  }
}

export function wordWrap(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const f = new Filler(w);
  for (const p of pieces(s)) {
    if ("esc" in p) f.esc(p.esc);
    else if ("space" in p) f.gap += p.space;
    else if (p.width <= w) f.word(p.word, p.width);
    else f.long(p.word);
  }
  return f.end();
}
