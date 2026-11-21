// Text primitives every tui file uses: styling, display width, sanitising,
// tab expansion, grapheme cells, cell-exact and word wrapping, fitting. Pure,
// with no tui dependencies.

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** The SGR reset and OSC 8 link open/close, as markdown.ts and the word wrapper write them. */
export const RESET = "\x1b[0m";
export const linkOpen = (url: string) => `\x1b]8;;${url}\x1b\\`;
export const LINK_CLOSE = "\x1b]8;;\x1b\\";

/** One grapheme cluster: text[at, end), `width` columns wide. */
export interface Cell { at: number; end: number; text: string; width: number }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The grapheme clusters of text[start, end). */
export function cells(text: string, start = 0, end = text.length): Cell[] {
  const out: Cell[] = [];
  for (const { segment, index } of segmenter.segment(text.slice(start, end))) {
    out.push({ at: start + index, end: start + index + segment.length, text: segment, width: Bun.stringWidth(segment) });
  }
  return out;
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

/** Untrusted plain fields: no terminal styling, hyperlinks, controls or bidi overrides. */
export function plainText(text: string): string {
  return Bun.stripANSI(sanitize(text.replace(/\r\n?|\n|\t|\u2028|\u2029/g, " ")))
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
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

/** Replay the SGR state on a soft wrap; a full reset discards its predecessors. */
function continuedStyle(style: string, esc: string): string {
  if (!/^\x1b\[[0-9;:]*m$/.test(esc)) return style;
  return /^\x1b\[(?:0)?m$/.test(esc) ? "" : style + esc;
}

/** A two-column glyph cannot fit a one-column screen: show an ellipsis without corrupting geometry. */
const fittingCell = (c: { text: string; width: number }, cols: number) => c.width > cols ? { text: "…", width: 1 } : c;

/** Split a styled line into pieces at most `cols` display columns wide. */
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

/** One row: cut with an ellipsis rather than wrapped. */
export function fit(raw: string, cols: number): string {
  if (cols <= 0) return "";
  const line = expandTabs(raw);
  if (visibleLength(line) <= cols) return line;
  if (cols === 1) return "…";
  return wrap(line, Math.max(1, cols - 1))[0]!.replace(/\x1b\[0m$/, "") + "…\x1b[0m";
}

// --- word wrapping ----------------------------------------------------------

const ESC = /\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/y;

/** A styled string as escapes and breakable words: a run of spaces, one wide character, or a run of narrow ones. */
function* pieces(s: string): Generator<{ esc: string } | { space: number } | { word: string; width: number }> {
  let i = 0;
  while (i < s.length) {
    ESC.lastIndex = i;
    const m = s[i] === "\x1b" ? ESC.exec(s) : null;
    if (m) { yield { esc: m[0] }; i += m[0].length; continue; }
    let j = i;
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
    if (word && (space || c.width > 1)) { yield { word, width }; word = ""; width = 0; }
    if (space) yield { space: 1 };
    else if (c.width > 1) yield { word: c.text, width: c.width };
    else { word += c.text; width += c.width; }
  }
  if (word) yield { word, width };
}

/** Styles in force at a point of a styled string, to close a line and reopen them on the next. */
class Pen {
  sgr: string[] = [];
  url = "";
  apply(esc: string): void {
    if (esc.startsWith("\x1b]")) this.url = /^\x1b\]8;[^;]*;([^\x07\x1b]*)/.exec(esc)?.[1] ?? "";
    else if (esc === RESET || esc === "\x1b[m") this.sgr = [];
    else this.sgr.push(esc);
  }
  close(): string { return `${this.url ? LINK_CLOSE : ""}${this.sgr.length ? RESET : ""}`; }
  open(): string { return `${this.sgr.join("")}${this.url ? linkOpen(this.url) : ""}`; }
}

/** Lines being filled to a width; styles and links in force carry over a break. */
class Filler {
  readonly lines: string[] = [];
  private line = "";
  private used = 0;
  /** Spaces since the last word, written only if another word follows on the line. */
  gap = 0;
  /** Escapes after a space: they go with the next word, so a style never starts on the line before. */
  private held: string[] = [];
  private readonly pen = new Pen();
  constructor(private readonly w: number) {}

  esc(e: string): void {
    if (this.gap) { this.held.push(e); return; }
    this.line += e;
    this.pen.apply(e);
  }

  word(text: string, tw: number): void {
    if (this.used && this.used + this.gap + tw > this.w) this.newLine();
    if (this.used) { this.line += " ".repeat(this.gap); this.used += this.gap; }
    this.gap = 0;
    for (const e of this.held.splice(0)) this.esc(e);
    this.line += text;
    this.used += tw;
  }

  /** A word wider than a line: from a fresh line, cut a cell at a time. */
  long(word: string): void {
    if (this.used) this.newLine();
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

/** Word-wrap a styled string to `width` columns; styles and links carry over to the next line, and a word too long for a line is cut, starting on a line of its own. */
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
