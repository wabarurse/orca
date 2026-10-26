// Markdown → styled terminal lines, pure. Only SGR styling and OSC 8 links
// are written, so the output passes render.ts `sanitize` untouched.
//
// The text is cut into blocks (`takeBlocks`) and each block renders on its
// own (`renderBlock`): a blank run, one line (paragraph, heading, list item,
// quote, rule), a fenced code block or a table. Like Codex, a line break in
// the source stays a line break, so a reply can be committed line by line as
// it streams (see mdstream.ts) and render the same as all at once.

import { cells } from "../footer/editor";

const SGR = { bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", underline: "\x1b[4m", strike: "\x1b[9m", code: "\x1b[36m" };
const RESET = "\x1b[0m";
const dim = (s: string) => `${SGR.dim}${s}${RESET}`;
const linkOpen = (url: string) => `\x1b]8;;${url}\x1b\\`;
const LINK_CLOSE = "\x1b]8;;\x1b\\";

// --- inline -----------------------------------------------------------------

interface Hit { out: string; next: number }
type Rule = (s: string, i: number, outer: string, links: boolean) => Hit | null;

const isAlnum = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);
const isSpace = (c: string | undefined) => !c || /\s/.test(c);

/** A styled span: open, content (nested styles keep the outer ones), then back to exactly the outer style. */
const span = (open: string, content: string, outer: string, links: boolean) => `${open}${inline(content, outer + open, links)}${RESET}${outer}`;

const runAt = (s: string, i: number) => {
  let k = i;
  while (s[k] === s[i]) k++;
  return k - i;
};

/** Where the code span opened by the backtick run at `i` ends (just past its closing run), or -1 when it never closes. */
function codeEnd(s: string, i: number): number {
  const r = runAt(s, i);
  const fence = "`".repeat(r);
  let j = s.indexOf(fence, i + r);
  while (j !== -1 && runAt(s, j) !== r) j = s.indexOf(fence, j + runAt(s, j));
  return j === -1 ? -1 : j + r;
}

/** Past an escape or a code span at `j` (their characters never close emphasis), or `j` itself. */
function skipAt(s: string, j: number): number {
  if (s[j] === "\\") return j + 2;
  if (s[j] !== "`") return j;
  const end = codeEnd(s, j);
  return end === -1 ? j + runAt(s, j) : end;
}

/** A run of `n` delimiters at `j` may open: it follows no letter or digit (so snake_case, 2*3 stay literal) and a non-space follows it. */
const canOpen = (s: string, j: number, n: number) => !isAlnum(s[j - 1]) && !isSpace(s[j + n]);
/** A run of `r` at `j` may close: it follows a non-space and no letter or digit follows it. */
const canClose = (s: string, j: number, r: number, from: number) => j > from && !isSpace(s[j - 1]) && !isAlnum(s[j + r]);

/**
 * Where an emphasis run of `n` × `c` opened just before `from` closes, as
 * [content end, after closer], or null. Escapes and code spans are skipped; a
 * run of exactly `n` closes; a run that opens a span of its own is skipped
 * with that span (so `*a **b** c*` nests); a longer run that cannot open
 * closes with its first `n`, leaving the rest to an outer span (so
 * `**a *b***` closes both, as in CommonMark).
 */
function closer(s: string, from: number, c: string, n: number): [number, number] | null {
  let j = from;
  while (j < s.length) {
    const skip = skipAt(s, j);
    if (skip !== j || s[j] !== c) { j = Math.max(skip, j + 1); continue; }
    const step = atRun(s, j, from, n);
    if (Array.isArray(step)) return step;
    j = step;
  }
  return null;
}

/** At a run of the delimiter at `j`: where it closes the span, or where to scan on past it (and any span it opens). */
function atRun(s: string, j: number, from: number, n: number): [number, number] | number {
  const r = runAt(s, j);
  const closes = canClose(s, j, r, from);
  if (closes && r === n) return [j, j + r];
  const m = Math.min(r, 3);
  const inner = canOpen(s, j, m) ? closer(s, j + m, s[j]!, m) : null;
  if (inner) return inner[1];
  return closes && r > n ? [j, j + n] : j + r;
}

const EMPHASIS: Record<string, Record<number, string>> = {
  "*": { 1: SGR.italic, 2: SGR.bold, 3: SGR.bold + SGR.italic },
  _: { 1: SGR.italic, 2: SGR.bold, 3: SGR.bold + SGR.italic },
  "~": { 2: SGR.strike },
};

/**
 * *italic*, **bold**, ***both***, ~~strike~~. Stricter than CommonMark on purpose: an
 * opener never follows a letter or digit, for * as for _, so 2*3, a*b*c and
 * snake_case stay literal. An unmatched run is literal as a whole (a run is
 * never split between an opener and a closer as CommonMark may).
 */
const emphasis: Rule = (s, i, outer, links) => {
  const c = s[i]!;
  const r = runAt(s, i);
  const n = Math.min(r, 3);
  const style = EMPHASIS[c]![n];
  const literal = { out: s.slice(i, i + r), next: i + r };
  if (!style || !canOpen(s, i, n)) return literal;
  const end = closer(s, i + n, c, n);
  if (!end) return literal;
  return { out: span(style, s.slice(i + n, end[0]), outer, links), next: end[1] };
};

const codeSpan: Rule = (s, i, outer) => {
  const r = runAt(s, i);
  const end = codeEnd(s, i);
  if (end === -1) return { out: "`".repeat(r), next: i + r };
  let code = s.slice(i + r, end - r);
  if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
  return { out: `${SGR.code}${code}${RESET}${outer}`, next: end };
};

const PUNCTUATION = /[\p{P}\p{S}]/u;
const escape: Rule = (s, i) => {
  const c = s[i + 1];
  return c && c < "\x7f" && PUNCTUATION.test(c) ? { out: c, next: i + 2 } : null;
};

/** A clean URL: no controls or spaces, so it cannot break out of the OSC 8 sequence. */
const cleanUrl = (u: string) => u.replace(/[\x00-\x20\x7f-\x9f]/g, "");

/** Only these schemes become OSC 8 links; anything else (javascript:, file:, relative paths) is plain text. */
function linkable(url: string): boolean {
  if (/[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return ((parsed.protocol === "https:" || parsed.protocol === "http:") && !!parsed.hostname && !parsed.username && !parsed.password)
      || (parsed.protocol === "mailto:" && !!parsed.pathname);
  } catch { return false; }
}

/**
 * Link text as an OSC 8 hyperlink; like Codex, the URL follows in brackets
 * when the text is something else. Empty text shows the URL.
 */
function link(rawText: string, rawUrl: string, outer: string): string {
  const url = cleanUrl(rawUrl);
  const text = rawText.trim() ? rawText : url;
  const label = inline(text, outer, false);
  const clickable = linkable(rawUrl);
  const shown = clickable ? `${linkOpen(url)}${label}${LINK_CLOSE}` : label;
  const destination = clickable ? `${linkOpen(url)}(${url})${LINK_CLOSE}` : `(${url})`;
  return text === url ? shown : `${shown} ${SGR.dim}${destination}${RESET}${outer}`;
}

/** [text](url "title"): the URL may hold balanced (...) groups anywhere, as in Wikipedia links. */
const LINK = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?((?:[^\s<>()]|\([^\s<>()]*\))+)>?(?:\s+"[^"]*")?\s*\)/;
const markdownLink: Rule = (s, i, outer) => {
  const m = LINK.exec(s.slice(i));
  return m ? { out: link(m[1]!, m[2]!, outer), next: i + m[0].length } : null;
};

const autolink: Rule = (s, i, outer) => {
  const m = /^<((?:https?|mailto):[^\s<>]+)>/.exec(s.slice(i));
  return m ? { out: link(m[1]!, m[1]!, outer), next: i + m[0].length } : null;
};

const RULES: Record<string, Rule> = { "\\": escape, "`": codeSpan, "[": markdownLink, "<": autolink, "*": emphasis, _: emphasis, "~": emphasis };

/** Bare web URLs get explicit OSC 8 targets too: do not depend on terminal URL heuristics. */
const bareLink: Rule = (s, i) => {
  if (i > 0 && /[\w@/]/u.test(s[i - 1]!)) return null;
  const match = /^https?:\/\/[^\s<>`"\x00-\x1f\x7f-\x9f]+/i.exec(s.slice(i));
  if (!match) return null;
  let url = match[0];
  // Peel prose punctuation repeatedly: e.g. `url]).` has several different
  // closers. Keep balanced URL syntax, notably brackets around IPv6 hosts.
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (url) {
    const last = url.at(-1)!;
    const open = pairs[last];
    if (/[.,;:!?'“”‘’«»]/u.test(last)
      || (open && url.split(last).length > url.split(open).length)) url = url.slice(0, -1);
    else break;
  }
  if (!linkable(url)) return null;
  return { out: `${linkOpen(url)}${url}${LINK_CLOSE}`, next: i + url.length };
};

/** Inline markdown → styled text. `outer` is restored after every styled span.
 * `links` is false throughout a link label, including recursively styled spans:
 * OSC 8 cannot nest, so only the enclosing destination may own those cells. */
export function inline(s: string, outer = "", links = true): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const rule = !links && (s[i] === "[" || s[i] === "<") ? undefined : RULES[s[i]!];
    const hit = rule?.(s, i, outer, links) ?? (links && /[hH]/.test(s[i]!) ? bareLink(s, i, outer, links) : null);
    if (hit) { out += hit.out; i = hit.next; }
    else { out += s[i]; i++; }
  }
  return out;
}

// --- wrapping ---------------------------------------------------------------

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

const width = (s: string) => Bun.stringWidth(s);

// --- blocks -----------------------------------------------------------------

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
export const isBlank = (l: string) => !l.trim();
const isTableRow = (l: string) => l.includes("|") && !isBlank(l);
/** A delimiter row under `header`: dashes with optional colons, as many cells as the header (GitHub's rule). */
const isDelimiter = (l: string, header: string) => DELIMITER.test(l) && l.includes("|") && splitRow(l).length === splitRow(header).length;

/** The index of the line closing the fence opened by `open`, or -1. */
function fenceEnd(lines: string[], i: number): number {
  const [, , mark] = FENCE.exec(lines[i]!)!;
  for (let j = i + 1; j < lines.length; j++) {
    const m = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]!);
    if (m && m[1]![0] === mark![0] && m[1]!.length >= mark!.length) return j;
  }
  return -1;
}

function runLength(lines: string[], i: number, test: (l: string) => boolean): number {
  let j = i;
  while (j < lines.length && test(lines[j]!)) j++;
  return j - i;
}

/**
 * How many lines the block starting at lines[i] takes, or 0 when it may not be
 * complete yet: a code block waits for its closing fence, a table for a line
 * that is not a row, a possible table header for the next line, and a blank
 * run for what follows it. With `end` set everything is complete.
 */
function blockLength(lines: string[], i: number, end: boolean): number {
  const line = lines[i]!;
  const left = lines.length - i;
  // A block that runs to the end of what has arrived may go on: wait unless this is the end.
  const upTo = (n: number) => (n < left || end ? n : 0);
  if (isBlank(line)) return upTo(runLength(lines, i, isBlank));
  if (FENCE.test(line)) { const j = fenceEnd(lines, i); return j !== -1 ? j - i + 1 : upTo(left); }
  if (!isTableRow(line)) return 1;
  if (left === 1) return upTo(left);
  if (!isDelimiter(lines[i + 1]!, line)) return 1;
  return upTo(2 + runLength(lines, i + 2, isTableRow));
}

/**
 * The complete blocks at the front of `lines` and how many lines they used. A
 * blank run becomes one "" block, and only between blocks: trailing blank
 * lines wait (or are dropped with `end`). Leading ones are the caller's to drop.
 */
export function takeBlocks(lines: string[], end: boolean): { blocks: string[]; used: number } {
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const n = blockLength(lines, i, end);
    if (!n) break;
    const trailing = i + n === lines.length && isBlank(lines[i]!);
    if (!trailing) blocks.push(isBlank(lines[i]!) ? "" : lines.slice(i, i + n).join("\n"));
    i += n;
  }
  return { blocks, used: i };
}

/** Split source text into lines, dropping leading blank lines and a final newline (the stream does the same). */
export function sourceLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); // the final newline ends the last line, as in the stream
  const first = lines.findIndex((l) => !isBlank(l));
  return first === -1 ? [] : lines.slice(first);
}

/** Optional reflow metadata: one call per stable source part, before gutters/padding.
 * Text offsets ignore wrap-discarded spaces; literal parts retain every grapheme.
 * Tables are atomic until their grid/stacked cells expose source positions.
 */
export type RowTrace = (rows: string[], mode?: "literal" | "block") => void;

function traced(rows: string[], trace?: RowTrace, mode?: "literal" | "block"): string[] {
  trace?.(rows, mode);
  return rows;
}

/** Render markdown text as styled lines at most `width` columns wide (a code line wider than that is cut onto more). */
export function renderMarkdown(text: string, width: number, trace?: RowTrace): string[] {
  return takeBlocks(sourceLines(text), true).blocks.flatMap((b) => renderBlock(b, width, trace));
}

/**
 * Markdown led by a styled label, e.g. who a reply is from: on the first line
 * when the text starts with a plain paragraph, else on a line of its own.
 */
export function renderLabelled(label: string, text: string, width: number, trace?: RowTrace): string[] {
  const blocks = takeBlocks(sourceLines(text), true).blocks;
  const first = blocks[0] ?? "";
  const head = !isParagraph(first)
    ? [...traced([label], trace), ...(first ? renderBlock(first, width, trace) : [])]
    : traced(wordWrap(`${label} ${inline(clean(first))}`, width), trace);
  return [...head, ...blocks.slice(1).flatMap((b) => renderBlock(b, width, trace))];
}

/** A block that is one plain unindented paragraph line. */
const isParagraph = (block: string) =>
  !!block && !block.includes("\n") && !FENCE.test(block) && LINE_RULES.findIndex(([re]) => re.test(block)) === LINE_RULES.length - 1 && !/^\s/.test(block);

/** Any escape sequence: CSI, OSC, DCS/SOS/PM/APC strings, two-byte ESC sequences. */
const ANY_ESCAPE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -\/]*[0-~])?/g;

/** Control characters (but tab and newline) and escapes out, tabs to spaces: all styling is ours. */
function clean(s: string): string {
  return s.replace(ANY_ESCAPE, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").split("\n").map(expandTabs).join("\n");
}

function expandTabs(line: string): string {
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(4 - (width(out) % 4)) : ch;
  return out;
}

/** One block from `takeBlocks` as styled lines. */
export function renderBlock(block: string, cols: number, trace?: RowTrace): string[] {
  const w = Math.max(1, cols);
  const lines = clean(block).split("\n");
  if (block === "") return traced([""], trace);
  if (FENCE.test(lines[0]!)) return codeBlock(lines, w, trace);
  if (lines.length > 1) return traced(table(lines, w), trace, "block");
  return renderLine(lines[0]!, w, trace);
}

// --- one-line blocks --------------------------------------------------------

type LineRule = [RegExp, (m: RegExpExecArray, w: number, trace?: RowTrace) => string[]];

const HEADING_STYLE = [SGR.bold + SGR.underline, SGR.bold, SGR.bold + SGR.italic];

const LINE_RULES: LineRule[] = [
  [/^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/, (m, w, trace) => {
    const style = HEADING_STYLE[Math.min(m[1]!.length, 3) - 1]!;
    return traced(wordWrap(`${style}${inline(m[2]!, style)}${RESET}`, w), trace);
  }],
  [/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/, (_m, w, trace) => traced([dim("─".repeat(w))], trace, "block")],
  [/^\s*>\s?(.*)$/, (m, w, trace) => renderLine(m[1]!, w - 2, trace).map((l) => `${dim("│")} ${l}`)],
  [/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/, (m, w, trace) => listItem(m[1]!.length, m[2]!, m[3]!, w, trace)],
  [/^(\s*)(.*)$/, (m, w, trace) => hanging(Math.min(m[1]!.length, Math.floor(w / 2)), "", m[2]!, w, trace)],
];

/** A heading, rule, quote, list item or paragraph line. */
function renderLine(line: string, w: number, trace?: RowTrace): string[] {
  for (const [re, render] of LINE_RULES) {
    const m = re.exec(line);
    if (m) return render(m, Math.max(1, w), trace);
  }
  return traced([line], trace);
}

/** `marker` then the text, wrapped with continuation lines indented under the text. */
function hanging(indent: number, marker: string, text: string, w: number, trace?: RowTrace): string[] {
  const lead = " ".repeat(indent) + marker;
  const pad = " ".repeat(width(lead));
  return traced(wordWrap(inline(text), w - width(lead)), trace).map((l, i) => (i ? pad : lead) + l);
}

/** Bullets show as "-" as in Codex; numbers stay as written. Nesting keeps the source indent. */
function listItem(indent: number, mark: string, text: string, w: number, trace?: RowTrace): string[] {
  const marker = /\d/.test(mark) ? `${mark} ` : "- ";
  return hanging(Math.min(indent, Math.floor(w / 2)), marker, text, w, trace);
}

// --- code blocks ------------------------------------------------------------

const GUTTER = dim("│") + " ";

/** A dim gutter and, when given, the language as a dim label; lines are cut only when wider than the screen. */
function codeBlock(lines: string[], w: number, trace?: RowTrace): string[] {
  const [, indent, , lang] = FENCE.exec(lines[0]!)!;
  const closed = lines.length > 1 && /^\s*(`{3,}|~{3,})\s*$/.test(lines.at(-1)!);
  const body = lines.slice(1, closed ? -1 : undefined).map((l) => stripIndent(l, indent!.length));
  const label = lang ? traced([GUTTER + dim(lang)], trace, "block") : [];
  return [...label, ...body.flatMap((l) => traced(cut(l, w - 2), trace, "literal").map((r) => GUTTER + r))];
}

const stripIndent = (l: string, n: number) => l.replace(new RegExp(`^ {0,${n}}`), "");

/** Cut plain text into rows of at most `w` columns. */
function cut(text: string, w: number): string[] {
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const c of cells(text)) {
    if (used && used + c.width > Math.max(1, w)) { rows.push(row); row = ""; used = 0; }
    row += c.text;
    used += c.width;
  }
  rows.push(row);
  return rows;
}

// --- tables -----------------------------------------------------------------

type Align = "left" | "center" | "right";

/** A row's cells: split at unescaped pipes outside code spans, outer pipes dropped. */
export function splitRow(line: string): string[] {
  const cellsOut: string[] = [];
  let cell = "";
  let code = false;
  const s = line.trim().replace(/^\|/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") { cell += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cellsOut.push(cell.trim()); cell = ""; continue; }
    cell += c;
  }
  if (cell.trim() || !line.trim().endsWith("|")) cellsOut.push(cell.trim());
  return cellsOut;
}

const alignOf = (d: string): Align => {
  const t = d.trim();
  if (t.startsWith(":") && t.endsWith(":")) return "center";
  return t.endsWith(":") ? "right" : "left";
};

/** A cell's text as styled pieces: <br> splits it as GitHub does. */
const cellText = (raw: string, header: boolean) =>
  raw.split(/<br\s*\/?>/i).map((p) => (header ? `${SGR.bold}${inline(p, SGR.bold)}${RESET}` : inline(p)));

const cellWidth = (parts: string[]) => Math.max(0, ...parts.map(width));

/** Columns are never squeezed below this (or their natural width) before the table gives up on a grid. */
const MIN_COLUMN = 6;

/**
 * Column widths that fit in `room` columns: the natural widths when they fit,
 * else the widest columns shrunk (to a common cap) until they do, or null when
 * even MIN_COLUMN each will not fit.
 */
export function fitColumns(natural: number[], room: number): number[] | null {
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  if (sum(natural) <= room) return natural;
  const floor = natural.map((n) => Math.min(n, MIN_COLUMN));
  if (sum(floor) > room) return null;
  const at = (cap: number) => natural.map((n, i) => Math.max(floor[i]!, Math.min(n, cap)));
  let cap = Math.max(...natural);
  while (sum(at(cap)) > room) cap--;
  const widths = at(cap);
  let extra = room - sum(widths);
  for (let i = 0; i < widths.length && extra > 0; i++) if (widths[i]! < natural[i]!) { widths[i]!++; extra--; }
  return widths;
}

function pad(s: string, w: number, align: Align): string {
  const free = Math.max(0, w - width(s));
  const left = align === "right" ? free : align === "center" ? Math.floor(free / 2) : 0;
  return " ".repeat(left) + s + " ".repeat(free - left);
}

const border = (ws: number[], [l, m, r]: string) => dim(l + ws.map((w) => "─".repeat(w + 2)).join(m) + r);

/** One table row's lines: every cell wrapped to its column, padded to the tallest. */
function rowLines(row: string[][], ws: number[], aligns: Align[]): string[] {
  const wrapped = row.map((parts, i) => parts.flatMap((p) => wordWrap(p, ws[i]!)));
  const height = Math.max(1, ...wrapped.map((c) => c.length));
  const bar = dim("│");
  return Array.from({ length: height }, (_, r) =>
    `${bar} ${wrapped.map((c, i) => pad(c[r] ?? "", ws[i]!, aligns[i]!)).join(` ${bar} `)} ${bar}`);
}

/** A table block: a box-drawn grid with a bold header, or one block per row when no grid fits. */
function table(lines: string[], w: number): string[] {
  const header = splitRow(lines[0]!);
  const n = header.length;
  const aligns = splitRow(lines[1]!).map(alignOf);
  const fill = (r: string[]) => Array.from({ length: n }, (_, i) => r[i] ?? "");
  const body = lines.slice(2).map((l) => fill(splitRow(l)));
  const rows = [header.map((c) => cellText(c, true)), ...body.map((r) => r.map((c) => cellText(c, false)))];
  const natural = Array.from({ length: n }, (_, i) => Math.max(1, ...rows.map((r) => cellWidth(r[i]!))));
  const ws = fitColumns(natural, w - (3 * n + 1));
  if (!ws) return stacked(header, body, w);
  const drawn = rows.map((r) => rowLines(r, ws, aligns));
  const ruled = drawn.slice(1).some((r) => r.length > 1);
  const between = border(ws, "├┼┤");
  const bodyLines = drawn.slice(1).flatMap((r, i) => (ruled && i ? [between, ...r] : r));
  return [border(ws, "┌┬┐"), ...drawn[0]!, between, ...bodyLines, border(ws, "└┴┘")];
}

/**
 * The narrow fallback: each row as "key: value" lines, rows apart by a blank
 * line, continuation lines indented (when there is room). A table with no
 * rows shows its header cells, one per line.
 */
function stacked(header: string[], body: string[][], w: number): string[] {
  const key = (h: string, i: number) => `${SGR.bold}${inline(h || `${i + 1}`, SGR.bold)}${RESET}`;
  const indent = w >= 4 ? 2 : 0;
  const entry = (first: string, rest = "") =>
    wordWrap(first + rest, w - indent).map((l, j) => (j ? " ".repeat(indent) : "") + l);
  if (!body.length) return header.flatMap((h, i) => entry(key(h, i)));
  return body.flatMap((row, r) => [
    ...(r ? [""] : []),
    ...row.flatMap((cell, i) => entry(`${key(header[i]!, i)}${SGR.bold}:${RESET} `, inline(cell.replace(/<br\s*\/?>/gi, " ")))),
  ]);
}
