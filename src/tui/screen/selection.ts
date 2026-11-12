// Mouse selection and links. A drag that begins on a committed conversation row selects history
// (ConversationSelection: it scrolls with its text); one that begins anywhere else selects the
// painted frame (FrameSelection). Reflow or changed text cancels a selection rather than
// silently copying different text. Soft wraps are copied as displayed newlines. A click on a
// link is found here too (linkAt), since mouse reporting keeps the click from the terminal.
import { cells } from "../components";
import { fit, sanitize } from "../components";
const plainRow = (row: string, cols: number) => Bun.stripANSI(fit(sanitize(row), cols));
import type { Key } from "../components";
import type { StickyScreen } from './sticky';
interface Point { row: number; col: number }
/** The committed history row (index into `history`) and column under a mouse report, or nothing when it is outside the painted body. */
export function hitRow(k: Key, screen: StickyScreen, length: number): Point | undefined {
  const row = (k.y ?? 0) - 1 - screen.bodyTop;
  const index = screen.start + row;
  const col = (k.x ?? 0) - 1;
  if (row < 0 || row >= screen.bodyHeight || index >= length || col < 0 || col >= screen.cols) return;
  return { row: index, col };
}
/** A span of cells over rows of plain text, in whatever rows its owner counts. */
class Span {
  protected anchor?: Point;
  protected end?: Point;
  protected snapshot: string[] = [];
  protected dragging = false;
  clear(): void { this.anchor = this.end = undefined; this.snapshot = []; this.dragging = false; }
  get active(): boolean { return !!this.anchor; }
  protected range(): [Point, Point] | undefined {
    if (!this.anchor || !this.end) return;
    const a = this.anchor, b = this.end;
    return a.row < b.row || a.row === b.row && a.col <= b.col ? [a, b] : [b, a];
  }
  protected pieces(row: number): [string, string, string] {
    const [a, b] = this.range()!;
    const text = this.snapshot[row] ?? '';
    let x = 0, before = '', selected = '', after = '';
    for (const c of cells(text)) {
      if (row === a.row && x + c.width <= a.col) before += c.text;
      else if (row === b.row && x > b.col) after += c.text;
      else selected += c.text;
      x += c.width;
    }
    return [before, selected, after];
  }
  protected lines(): string[] {
    const range = this.range();
    if (!range) return [];
    const out: string[] = [];
    for (let r = range[0].row; r <= range[1].row; r++) out.push(this.pieces(r)[1]);
    return out;
  }
}
export class ConversationSelection extends Span {
  mouse(k: Key, screen: StickyScreen, history: string[]): boolean {
    const point = hitRow(k, screen, history.length);
    if (k.name === 'mousedown') { this.start(point, screen.cols, history); return false; }
    if (!this.dragging) return false;
    if (k.name === 'mouseup' && (!point || point.row >= this.snapshot.length)) { this.clear(); return false; }
    if (point && point.row < this.snapshot.length) this.end = point;
    if (k.name === 'mouseup') {
      this.dragging = false;
      if (this.anchor!.row === this.end!.row && this.anchor!.col === this.end!.col) { this.clear(); return false; }
      return true;
    }
    return false;
  }
  private start(point: Point | undefined, cols: number, history: string[]): void {
    this.clear();
    if (!point) return;
    this.snapshot = history.map(s => plainRow(s, cols));
    this.anchor = this.end = point;
    this.dragging = true;
  }
  text(): string { return this.lines().join('\n'); }
  paint(screen: StickyScreen, history: string[]): void {
    const range = this.range();
    if (!range) return;
    const [a, b] = range;
    for (let r = a.row; r <= b.row; r++) {
      if (history[r] === undefined || plainRow(history[r]!, screen.cols) !== this.snapshot[r]) { this.clear(); return; }
    }
    for (let r = Math.max(a.row, screen.start); r <= Math.min(b.row, screen.start + screen.bodyHeight - 1); r++) {
      const [before, selected, after] = this.pieces(r);
      if (selected) screen.rows[screen.bodyTop + r - screen.start] = before + '\x1b[7m' + selected + '\x1b[0m' + after;
    }
  }
}

/** Everything else on screen: the header, the footer, the transient tail, a menu, the work page.
 * It counts painted screen rows, so it lasts only while the rows under it keep their text: a
 * scroll, a tick of a clock inside it or a new frame layout cancels it rather than copy other text. */
export class FrameSelection extends Span {
  /** True when a drag just ended away from where it began: paint once, then `text()` is what to copy. */
  mouse(k: Key): boolean {
    const point = { row: (k.y ?? 0) - 1, col: (k.x ?? 0) - 1 };
    if (k.name === 'mousedown') { this.clear(); this.anchor = this.end = point; this.dragging = true; return false; }
    if (!this.dragging) return false;
    this.end = point;
    if (k.name !== 'mouseup') return false;
    this.dragging = false;
    if (this.empty()) { this.clear(); return false; }
    return true;
  }
  private empty(): boolean { return !this.anchor || !this.end || this.anchor.row === this.end.row && this.anchor.col === this.end.col; }
  /** Trailing padding is the frame's, not the text's. */
  text(): string { return this.empty() ? '' : this.lines().map(line => line.trimEnd()).join('\n'); }
  /** Rows outside the span may change freely (the press itself often moves a marker); the ones inside may not. */
  paint(rows: string[], cols: number): void {
    const range = this.range();
    if (!range) return;
    const [a, b] = range, plain = rows.map(row => plainRow(row, cols)), fresh = !this.snapshot.length;
    for (let r = 0; r < plain.length; r++) {
      if (fresh || r < a.row || r > b.row) this.snapshot[r] = plain[r]!;
      else if (plain[r] !== this.snapshot[r]) { this.clear(); return; }
    }
    this.snapshot.length = plain.length;
    if (this.empty()) return;
    for (let r = Math.max(0, a.row); r <= Math.min(b.row, rows.length - 1); r++) {
      const [before, selected, after] = this.pieces(r);
      if (selected) rows[r] = before + '\x1b[7m' + selected + '\x1b[0m' + after;
    }
  }
}

const ESCAPE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-9;:?<>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const BARE_URL = /https?:\/\/[^\s<>"'`\x1b]+/g;
/** Only these are ever handed to the desktop, whatever a transcript printed. */
const OPENABLE = /^(?:https?:\/\/|mailto:)\S+$/i;
/** The link under column `col` of a painted row: its OSC 8 target, else a web address written out there. */
export function linkAt(row: string, col: number): string | undefined {
  let url: string | undefined, x = 0, i = 0;
  const openable = (found: string | undefined) => found && OPENABLE.test(found) ? found : undefined;
  while (i < row.length && col >= x) {
    ESCAPE.lastIndex = i;
    const m = row[i] === '\x1b' ? ESCAPE.exec(row) : null;
    if (m) { if (m[1] !== undefined) url = m[1] || undefined; i += m[0].length; continue; }
    let j = row.indexOf('\x1b', i + 1);
    if (j === -1) j = row.length;
    for (const c of cells(row, i, j)) {
      if (col < x + c.width) return openable(url) ?? bareLink(Bun.stripANSI(row), col);
      x += c.width;
    }
    i = j;
  }
}
function bareLink(plain: string, col: number): string | undefined {
  for (const m of plain.matchAll(BARE_URL)) {
    const text = m[0].replace(/[.,;:!?)\]}]+$/, ''), start = Bun.stringWidth(plain.slice(0, m.index));
    if (col >= start && col < start + Bun.stringWidth(text)) return text;
  }
}

/** What a press and its release mean, for everything a mouse can do on the screen. */
export class Pointer {
  readonly frame = new FrameSelection();
  /** The press began on a committed conversation row, whose selection scrolls with its text. */
  inBody = false;
  private pressed?: { x?: number; y?: number; url?: string };
  /** A release on the pressed cell is a click; one that began on a link carries its target. `rows` is the painted frame. */
  track(k: Key, rows?: string[]): { click?: Key; url?: string } {
    if (k.name === 'mousedown') { this.pressed = { x: k.x, y: k.y, url: rows && linkAt(rows[(k.y ?? 0) - 1] ?? '', (k.x ?? 0) - 1) }; return {}; }
    if (k.name !== 'mouseup') return {};
    const down = this.pressed;
    this.pressed = undefined;
    return down && down.x === k.x && down.y === k.y ? { click: k, ...(down.url ? { url: down.url } : {}) } : {};
  }
}
