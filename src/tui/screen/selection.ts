// Selection belongs to rendered, committed conversation rows, never the chrome or
// transient tool/activity tail. Reflow/context replacement cancels it rather than
// silently copying different text. Soft wraps are copied as displayed newlines.
import { cells } from '../footer/editor';
import { fit, sanitize } from '../components/render';
const plainRow = (row: string, cols: number) => Bun.stripANSI(fit(sanitize(row), cols));
import type { Key } from '../components/keys';
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
export class ConversationSelection {
  private anchor?: Point;
  private end?: Point;
  private snapshot: string[] = [];
  private dragging = false;
  clear(): void { this.anchor = this.end = undefined; this.snapshot = []; this.dragging = false; }
  get active(): boolean { return !!this.anchor; }
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
  private range(): [Point, Point] | undefined {
    if (!this.anchor || !this.end) return;
    const a = this.anchor, b = this.end;
    return a.row < b.row || a.row === b.row && a.col <= b.col ? [a, b] : [b, a];
  }
  private pieces(row: number): [string, string, string] {
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
  text(): string {
    const range = this.range();
    if (!range) return '';
    const out: string[] = [];
    for (let r = range[0].row; r <= range[1].row; r++) out.push(this.pieces(r)[1]);
    return out.join('\n');
  }
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
