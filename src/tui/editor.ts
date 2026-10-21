// The input area's editing, pure: a text plus a cursor (a string index) in,
// a new one out. The cursor moves by grapheme cluster, so 👍🏽 or a decomposed é
// is one step. Rows wrap at `width` display columns (the columns after the
// prompt; CJK and emoji count two); a logical line whose last row is full gets
// an empty row after it so the cursor has somewhere to sit.

export interface EditState { text: string; cursor: number }

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

const isWord = (g: string) => /[\p{L}\p{N}_]/u.test(g);
const isSpace = (g: string) => /^\s+$/u.test(g);

/** Index of the grapheme boundary before / after `i`. */
const prev = (text: string, i: number) => cells(text, 0, i).at(-1)?.at ?? 0;
function next(text: string, i: number): number {
  for (const { segment } of segmenter.segment(text.slice(i))) return i + segment.length;
  return text.length;
}

const lineStart = (text: string, i: number) => text.lastIndexOf("\n", i - 1) + 1;
function lineEnd(text: string, i: number): number {
  const n = text.indexOf("\n", i);
  return n === -1 ? text.length : n;
}

function replace(s: EditState, from: number, to: number, insert = ""): EditState {
  return { text: s.text.slice(0, from) + insert + s.text.slice(to), cursor: from + insert.length };
}

export const insert = (s: EditState, text: string) => replace(s, s.cursor, s.cursor, text);
export const newline = (s: EditState) => insert(s, "\n");
export const backspace = (s: EditState) => replace(s, prev(s.text, s.cursor), s.cursor);
export const deleteForward = (s: EditState) => replace(s, s.cursor, next(s.text, s.cursor));
export const left = (s: EditState): EditState => ({ ...s, cursor: prev(s.text, s.cursor) });
export const right = (s: EditState): EditState => ({ ...s, cursor: next(s.text, s.cursor) });
/** Home / End and the kills act on the current logical line. */
export const home = (s: EditState): EditState => ({ ...s, cursor: lineStart(s.text, s.cursor) });
export const end = (s: EditState): EditState => ({ ...s, cursor: lineEnd(s.text, s.cursor) });
export const killToStart = (s: EditState) => replace(s, lineStart(s.text, s.cursor), s.cursor);
export const killToEnd = (s: EditState) => replace(s, s.cursor, lineEnd(s.text, s.cursor));

/** Walk back from `i` over clusters that are not `inWord`, then over ones that are. */
function back(text: string, i: number, inWord: (g: string) => boolean): number {
  const cs = cells(text, 0, i);
  let k = cs.length;
  while (k > 0 && !inWord(cs[k - 1]!.text)) k--;
  while (k > 0 && inWord(cs[k - 1]!.text)) k--;
  return cs[k]?.at ?? i;
}
function forward(text: string, i: number, inWord: (g: string) => boolean): number {
  const cs = cells(text, i);
  let k = 0;
  while (k < cs.length && !inWord(cs[k]!.text)) k++;
  while (k < cs.length && inWord(cs[k]!.text)) k++;
  return cs[k]?.at ?? text.length;
}

/** Start of the word before `i`: skip non-word characters, then the word. */
export const wordBack = (text: string, i: number) => back(text, i, isWord);
/** End of the word after `i`. */
export const wordForward = (text: string, i: number) => forward(text, i, isWord);
export const wordLeft = (s: EditState): EditState => ({ ...s, cursor: wordBack(s.text, s.cursor) });
export const wordRight = (s: EditState): EditState => ({ ...s, cursor: wordForward(s.text, s.cursor) });
/** Alt+Backspace. */
export const deleteWordBack = (s: EditState) => replace(s, wordBack(s.text, s.cursor), s.cursor);
/** Alt+D. */
export const deleteWordForward = (s: EditState) => replace(s, s.cursor, wordForward(s.text, s.cursor));
/** Ctrl+W: the whitespace-delimited word before the cursor (unix-word-rubout). */
export const rubout = (s: EditState) => replace(s, back(s.text, s.cursor, (g) => !isSpace(g)), s.cursor);

/** A wrapped row: text[start, end). */
export interface Row { start: number; end: number; text: string }
export interface Layout { rows: Row[]; row: number; col: number }

const row = (text: string, start: number, end: number): Row => ({ start, end, text: text.slice(start, end) });

/** The rows of one logical line, text[start, end), at most `width` columns each. */
function wrapLine(text: string, start: number, end: number, width: number): Row[] {
  const out: Row[] = [];
  let rowStart = start;
  let used = 0;
  for (const c of cells(text, start, end)) {
    if (used > 0 && used + c.width > width) { out.push(row(text, rowStart, c.at)); rowStart = c.at; used = 0; }
    used += c.width;
  }
  out.push(row(text, rowStart, end));
  if (used >= width) out.push(row(text, end, end));
  return out;
}

/** Wrap `text` into rows of at most `width` columns and find the cursor's row and column. */
export function layout(s: EditState, width: number): Layout {
  const w = Math.max(1, width);
  const rows: Row[] = [];
  let start = 0;
  for (const line of s.text.split("\n")) {
    rows.push(...wrapLine(s.text, start, start + line.length, w));
    start += line.length + 1;
  }
  // Where a row ends the next one starts; the cursor sits on the later row.
  let r = rows.length - 1;
  while (r > 0 && rows[r]!.start > s.cursor) r--;
  return { rows, row: r, col: Bun.stringWidth(s.text.slice(rows[r]!.start, s.cursor)) };
}

/** Move the cursor one row up (-1) or down (1); null when it is already on the first / last row. */
export function vertical(s: EditState, width: number, dir: -1 | 1): EditState | null {
  const { rows, row: from, col } = layout(s, width);
  const to = from + dir;
  const target = rows[to];
  if (!target) return null;
  let i = target.start;
  let used = 0;
  for (const c of cells(s.text, target.start, target.end)) {
    if (used + c.width > col) break;
    used += c.width;
    i = c.end;
  }
  // The end of a soft-wrapped row is the start of the next; stay on the target row.
  if (i === target.end && i > target.start && rows[to + 1]?.start === i) i = prev(s.text, i);
  return { ...s, cursor: i };
}

/** The first row of a `shown`-row window over `total` rows that keeps `row` in view, moving `top` as little as possible. */
export function scrollWindow(top: number, row: number, total: number, shown: number): number {
  let t = Math.min(top, row);
  if (row >= t + shown) t = row - shown + 1;
  return Math.max(0, Math.min(t, total - shown));
}
