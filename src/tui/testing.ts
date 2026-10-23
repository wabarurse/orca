// A small but faithful terminal for tests. It applies the escape codes the
// TUI writes to a buffer of rows: the last `rows` rows are the visible screen,
// everything above is the scrollback. It autowraps with a pending wrap, gives
// wide characters two columns, scrolls on LF at the bottom, clamps cursor
// moves to the screen, and throws on any sequence it does not model, so a
// test fails when the TUI writes something a real terminal would misread.
// It tracks the SGR background (each cell keeps the one it was written with,
// `backgrounds()`), refuses an erase while a background is set (a real terminal
// would fill the erased cells with it), and answers an OSC 11 background query
// with `background` when that is set (the reply goes to `replies`).

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Csi = (s: FakeScreen, n: number[]) => void;

const arg = (n: number[], i = 0, def = 1) => n[i] || def;

/** CSI handlers by final byte; params are numbers (empty → 0). */
const CSI: Record<string, Csi> = {
  A: (s, n) => s.moveTo(s.row - arg(n), s.col),
  B: (s, n) => s.moveTo(s.row + arg(n), s.col),
  C: (s, n) => s.moveTo(s.row, s.col + arg(n)),
  D: (s, n) => s.moveTo(s.row, s.col - arg(n)),
  G: (s, n) => s.moveTo(s.row, arg(n) - 1),
  H: (s, n) => s.moveTo(arg(n) - 1, arg(n, 1) - 1),
  J: (s, n) => s.eraseDisplay(n[0] ?? 0),
  K: (s, n) => s.eraseLine(n[0] ?? 0),
};

/** 38/48/58 at ps[i] with its 5;n or 2;r;g;b arguments: the background it leaves, and how many params it took. */
function extendedColour(ps: string[], i: number, bg: string): [bg: string, used: number] {
  const len = ({ "5": 2, "2": 4 } as Record<string, number>)[ps[i + 1] ?? ""];
  if (!len || i + len >= ps.length) throw new Error(`unmodelled SGR ${ps.join(";")}`);
  return [ps[i] === "48" ? ps.slice(i, i + len + 1).join(";") : bg, len + 1];
}

/** The background one SGR param (with what follows it in `ps`) leaves, from `bg`; and how many params it took. */
function sgrParam(ps: string[], i: number, bg: string): [bg: string, used: number] {
  const p = ps[i]!;
  if (p.includes(":")) return [p.startsWith("48:") ? p : bg, 1]; // 48:5:n, 48:2::r:g:b
  if (/^(38|48|58)$/.test(p)) return extendedColour(ps, i, bg);
  if (/^0*$|^49$/.test(p)) return ["", 1];
  return [/^(4[0-7]|10[0-7])$/.test(p) ? p : bg, 1];
}

/** An SGR's params as the background they leave, from `bg` (a cell's background is its params, e.g. "48;5;236", or "" for none). */
function sgrBackground(params: string, bg: string): string {
  if (params === "") return "";
  const ps = params.split(";");
  for (let i = 0; i < ps.length;) {
    const [next, used] = sgrParam(ps, i, bg);
    bg = next;
    i += used;
  }
  return bg;
}

export interface CellStyle { bold: boolean; dim: boolean; foreground: string }
const DEFAULT_STYLE: CellStyle = { bold: false, dim: false, foreground: "" };

/** The foreground/intensity part of SGR; colour payload numbers never count as flags. */
function styledParam(p: string, style: CellStyle): CellStyle {
  if (/^(?:0)?$/.test(p)) return { ...DEFAULT_STYLE };
  if (p === "1") return { ...style, bold: true };
  if (p === "2") return { ...style, dim: true };
  if (p === "22") return { ...style, bold: false, dim: false };
  if (p === "39") return { ...style, foreground: "" };
  if (/^(?:3[0-7]|9[0-7]|38[:;].*)$/.test(p)) return { ...style, foreground: p };
  return style;
}

function sgrStyle(params: string, style: CellStyle): CellStyle {
  const ps = params.split(";");
  for (let i = 0; i < ps.length;) {
    const [, used] = sgrParam(ps, i, "");
    style = styledParam(ps.slice(i, i + used).join(";"), style);
    i += used;
  }
  return style;
}

/** DEC private modes it models: cursor visibility, bracketed paste, synchronized output. */
const MODES = new Set([25, 1000, 1002, 1006, 1049, 2004, 2026]);

export class FakeScreen {
  /** Every row, scrollback first; a row is cells, "" marking the right half of a wide character. */
  buf: string[][] = [];
  /** Each cell's background, parallel to `buf`: SGR params such as "48;5;236", "" for none. */
  private bgs: string[][] = [];
  /** The current SGR background. */
  private bg = "";
  private style: CellStyle = { ...DEFAULT_STYLE };
  private styles = new WeakMap<string[], CellStyle[]>();
  private primary?: { buf: string[][]; bgs: string[][]; row: number; col: number };
  /** What it answers an OSC 11 query with (e.g. "rgb:0000/0000/0000"); unset, it stays silent like a terminal without it. */
  background?: string;
  /** OSC 11 queries seen, and the replies they got (the terminal's input, for the test to feed back). */
  queries = 0;
  replies: string[] = [];
  /** Cursor on the visible screen (0-based). */
  row = 0;
  col = 0;
  /** Set after writing the last column: the next character wraps first. */
  private pending = false;
  readonly modes = new Map<number, boolean>([[25, true]]);
  /** How many times the scrollback was cleared (\x1b[3J). */
  clears = 0;

  constructor(public cols = 80, public rows = 24) {
    for (let i = 0; i < rows; i++) this.pushRow();
  }

  /** First buffer row of the visible screen. */
  get top(): number { return this.buf.length - this.rows; }

  private line(row = this.row): string[] { return this.buf[this.top + row]!; }
  private bgLine(row = this.row): string[] { return this.bgs[this.top + row]!; }
  private pushRow(): void { this.buf.push([]); this.bgs.push([]); }
  /** Cut a visible row to `n` cells. */
  private cut(row: number, n: number): void {
    const line = this.line(row);
    line.length = Math.min(line.length, n);
    this.bgLine(row).length = line.length;
    const styles = this.styles.get(line);
    if (styles) styles.length = line.length;
  }

  write(s: string): void {
    let i = 0;
    while (i < s.length) i = this.step(s, i);
    if (this.modes.get(2026)) throw new Error("synchronized output left on after a write");
    if (!this.modes.get(25)) throw new Error("cursor left hidden after a write");
  }

  /** Apply what starts at s[i]; returns where the next token starts. */
  private step(s: string, i: number): number {
    if (s[i] === "\x1b") return this.escape(s, i);
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (ch === "\r") this.moveTo(this.row, 0);
    else if (ch === "\n") this.lineFeed();
    else if (/[\x00-\x1f\x7f-\x9f]/.test(ch)) throw new Error(`unmodelled control ${JSON.stringify(ch)}`);
    else {
      // Treat complete printable runs as graphemes, like the renderer: combining
      // marks and ZWJ emoji must not add phantom rows and break erase assertions.
      const end = s.slice(i).search(/[\x00-\x1f\x7f-\x9f]/);
      const text = end < 0 ? s.slice(i) : s.slice(i, i + end);
      for (const { segment } of graphemes.segment(text)) this.put(segment);
      return i + text.length;
    }
    return i + ch.length;
  }

  /** The escapes it models, tried in order: each pattern's match is handed to its handler. */
  private readonly escapes: [RegExp, (m: RegExpExecArray) => void][] = [
    [/^\x1b\[\?(\d+)([hl])/, (m) => this.mode(Number(m[1]), m[2] === "h")],
    [/^\x1b\[([0-9;:]*)m/, (m) => { this.bg = sgrBackground(m[1]!, this.bg); this.style = sgrStyle(m[1]!, this.style); }],
    [/^\x1b\]11;\?(?:\x07|\x1b\\)/, () => this.query()],
    [/^\x1b\[([0-9;:]*)([ABCDGHJK])/, (m) => CSI[m[2]!]!(this, m[1] ? m[1].split(";").map((p) => Number(p) || 0) : [])],
    [/^\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/, () => {}], // OSC 8 links take no room
  ];

  private escape(s: string, i: number): number {
    const rest = s.slice(i);
    for (const [re, handle] of this.escapes) {
      const m = re.exec(rest);
      if (m) { handle(m); return i + m[0].length; }
    }
    throw new Error(`unmodelled escape ${JSON.stringify(rest.slice(0, 12))}`);
  }

  private mode(n: number, on: boolean): void {
    if (!MODES.has(n)) throw new Error(`unmodelled mode ?${n}`);
    if (n === 1049) this.alternate(on);
    this.modes.set(n, on);
  }

  private alternate(on: boolean): void {
    if (on && !this.primary) {
      this.primary = { buf: this.buf, bgs: this.bgs, row: this.row, col: this.col };
      this.buf = []; this.bgs = [];
      for (let i = 0; i < this.rows; i++) this.pushRow();
      this.moveTo(0, 0);
    } else if (!on && this.primary) {
      const saved = this.primary;
      this.buf = saved.buf; this.bgs = saved.bgs;
      while (this.buf.length < this.rows) this.pushRow();
      this.primary = undefined;
      this.moveTo(saved.row, saved.col);
    }
  }

  /** An OSC 11 query: answered with `background` when set, else ignored like a terminal without it. */
  private query(): void {
    this.queries++;
    if (this.background) this.replies.push(`\x1b]11;${this.background}\x1b\\`);
  }

  moveTo(row: number, col: number): void {
    this.pending = false;
    this.row = Math.max(0, Math.min(this.rows - 1, row));
    this.col = Math.max(0, Math.min(this.cols - 1, col));
  }

  private lineFeed(): void {
    this.pending = false;
    if (this.row < this.rows - 1) this.row++;
    else this.pushRow(); // the top row scrolls into the scrollback
  }

  private put(ch: string): void {
    const width = Bun.stringWidth(ch);
    if (width === 0) return;
    if (this.pending || this.col + width > this.cols) { this.lineFeed(); this.col = 0; }
    const line = this.line();
    const bgs = this.bgLine();
    while (line.length < this.col) { line.push(" "); bgs.push(""); }
    line[this.col] = ch;
    bgs[this.col] = this.bg;
    this.paint(this.col, width);
    if (width === 2) { line[this.col + 1] = ""; bgs[this.col + 1] = this.bg; }
    this.col += width;
    if (this.col >= this.cols) { this.col = this.cols - 1; this.pending = true; }
  }

  private paint(col: number, width: number): void {
    const line = this.line();
    const styles = this.styles.get(line) ?? [];
    for (let c = col; c < col + width; c++) styles[c] = { ...this.style };
    this.styles.set(line, styles);
  }

  /** Foreground and intensity for every cell (scrollback first), independently of background. */
  attributes(): CellStyle[][] {
    return this.buf.map((row) => row.map((_, c) => ({ ...(this.styles.get(row)?.[c] ?? DEFAULT_STYLE) })));
  }

  /** Erased cells would take the current background on a real terminal; nothing the TUI writes relies on that. */
  private plainErase(what: string): void {
    if (this.bg) throw new Error(`${what} with a background set (${this.bg})`);
  }

  eraseDisplay(n: number): void {
    this.plainErase(`J${n}`);
    if (n === 3) { const top = this.top; this.buf.splice(0, top); this.bgs.splice(0, top); this.clears++; return; }
    if (n === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.rows; r++) this.cut(r, 0);
    } else if (n === 1) {
      this.eraseLine(1);
      for (let r = 0; r < this.row; r++) this.cut(r, 0);
    } else if (n === 2) for (let r = 0; r < this.rows; r++) this.cut(r, 0);
    else throw new Error(`unmodelled J${n}`);
  }

  eraseLine(n: number): void {
    this.plainErase(`K${n}`);
    const line = this.line();
    const bgs = this.bgLine();
    if (n === 0) this.cut(this.row, this.col);
    else if (n === 1) for (let c = 0; c <= this.col && c < line.length; c++) { line[c] = " "; bgs[c] = ""; const styles = this.styles.get(line); if (styles) styles[c] = { ...DEFAULT_STYLE }; }
    else if (n === 2) this.cut(this.row, 0);
    else throw new Error(`unmodelled K${n}`);
  }

  /** Resize like xterm, without reflow: rows wider than the screen are cut; a shorter screen keeps the cursor's row on it, scrolling the top into the scrollback if needed and dropping rows below. */
  resize(cols: number, rows: number): void {
    const cursor = this.top + this.row;
    const top = this.row >= rows ? cursor - rows + 1 : this.top;
    this.buf.forEach((line, i) => { if (line.length > cols) line.length = this.bgs[i]!.length = cols; });
    this.buf.length = this.bgs.length = Math.min(this.buf.length, top + rows);
    while (this.buf.length < top + rows) this.pushRow();
    this.cols = cols;
    this.rows = rows;
    this.moveTo(cursor - top, this.col);
  }

  private static text(rows: string[][]): string[] { return rows.map((l) => l.join("").trimEnd()); }

  /** Every row's cell backgrounds, scrollback first, parallel to `buf` ("" for none; rows end at their last written cell). */
  backgrounds(): string[][] { return this.bgs.map((l) => [...l]); }

  /** The visible screen's rows, trailing spaces trimmed. */
  screen(): string[] { return FakeScreen.text(this.buf.slice(this.top)); }

  /** Scrollback and screen, trailing spaces trimmed and trailing blank rows dropped. */
  text(): string {
    const ls = FakeScreen.text(this.buf);
    while (ls.length > 1 && ls.at(-1) === "") ls.pop();
    return ls.join("\n");
  }
}
