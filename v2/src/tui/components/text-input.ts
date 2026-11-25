import type { Result } from "../../config";
import * as editor from "./editor";
import { cleanPaste, type Key } from "./keys";
import { dim, sanitize } from "./text";
import * as history from "./undo";

export type InputClipboard = { copy: (text: string) => Promise<Result<null>>; paste: () => Promise<Result<string>> };

export type TextInputProps = {
  placeholder: string;
  multiline: boolean;
  clipboard: InputClipboard | null;
  onChange: ((value: string) => void) | null;
  onSubmit: ((value: string) => Promise<void> | void) | null;
  onVertical: ((dir: -1 | 1, atEdge: boolean) => boolean) | null;
  onNote: ((text: string, error: boolean) => void) | null;
};

export type InputRows = { rows: string[]; row: number; col: number; cursor: boolean };
export type MousePhase = "down" | "drag" | "up";

export const DOUBLE_CLICK_MS = 400;
const SELECTED_ON = "\x1b[7m";
const SELECTED_OFF = "\x1b[27m";

export const defaultProps: TextInputProps = { placeholder: "", multiline: true, clipboard: null, onChange: null, onSubmit: null, onVertical: null, onNote: null };

type Click = { offset: number; time: number; count: number };

function highlighted(row: editor.Row, sel: editor.Span | null): string {
  if (sel === null || sel.to <= row.start || sel.from >= row.end) return sanitize(row.text);
  const a = Math.max(sel.from, row.start) - row.start;
  const b = Math.min(sel.to, row.end) - row.start;
  return `${sanitize(row.text.slice(0, a))}${SELECTED_ON}${sanitize(row.text.slice(a, b))}${SELECTED_OFF}${sanitize(row.text.slice(b))}`;
}

export class TextInput {
  private s: editor.EditState;
  private undoStack: history.Undo = history.empty();
  private focused: boolean;
  private top = 0;
  private width = 1;
  private goal: number | null = null;
  private click: Click | null = null;
  private drag: editor.Span | null = null;
  readonly props: TextInputProps;

  constructor(props: Partial<TextInputProps> = {}, initial = "", focused = true) {
    this.props = { ...defaultProps, ...props };
    this.s = editor.at(initial);
    this.focused = focused;
  }

  get value(): string { return this.s.text; }
  get state(): editor.EditState { return this.s; }
  get isFocused(): boolean { return this.focused; }
  get selected(): string { return editor.selectedText(this.s); }

  focus(): void { this.focused = true; }
  blur(): void { this.focused = false; this.drag = null; this.click = null; }

  setValue(text: string, cursor: number = text.length): void { this.set(editor.at(text, cursor), true); }
  restore(state: editor.EditState): void { this.set(state, true); }

  async key(key: Key): Promise<boolean> {
    if (!this.focused) return false;
    const mod = key.cmd === true || key.ctrl === true;
    if (mod && key.name === "z") { this.history(key.shift === true ? "redo" : "undo"); return true; }
    if (key.ctrl === true && key.name === "y") { this.history("redo"); return true; }
    if (key.cmd === true && (key.name === "c" || key.name === "x")) return this.copy(key.name === "x");
    if (key.cmd === true && key.name === "v") return this.paste();
    if (key.name === "enter") return this.enter(key);
    if ((key.name === "up" || key.name === "down") && key.cmd !== true) return this.vertical(key.name === "up" ? -1 : 1, key.shift === true);
    const edit = editor.apply(this.s, key);
    if (edit === null) return false;
    const text = this.props.multiline ? edit.state : { ...edit.state, text: edit.state.text.replace(/\n/g, " ") };
    this.commit(text, edit.kind);
    return true;
  }

  mouse(phase: MousePhase, row: number, col: number, now: number): void {
    const offset = editor.hit(this.s, this.width, this.top + row, col);
    if (phase === "up") { this.drag = null; return; }
    if (phase === "drag") {
      if (this.drag === null) return;
      const span = this.drag;
      const next = offset < span.from ? editor.select(this.s, { from: offset, to: span.to }, false) : editor.select(this.s, { from: span.from, to: Math.max(offset, span.to) });
      this.commit(next, "move");
      return;
    }
    this.focus();
    const again = this.click !== null && now - this.click.time <= DOUBLE_CLICK_MS && Math.abs(this.click.offset - offset) <= 1;
    const count = again && this.click !== null ? this.click.count % 3 + 1 : 1;
    this.click = { offset, time: now, count };
    const span = count === 1 ? { from: offset, to: offset } : count === 2 ? editor.wordAt(this.s.text, offset) : editor.lineAt(this.s.text, offset);
    this.drag = span;
    this.commit(count === 1 ? { ...this.s, cursor: offset, anchor: null } : editor.select(this.s, span), "move");
  }

  render(width: number, maxRows: number): InputRows {
    this.width = Math.max(1, width);
    const lay = editor.layout(this.s, this.width);
    const shown = Math.max(1, Math.min(lay.rows.length, maxRows));
    this.top = editor.scrollWindow(this.top, lay.row, lay.rows.length, shown);
    if (this.s.text.length === 0 && this.props.placeholder.length > 0) {
      return { rows: [dim(sanitize(this.props.placeholder))], row: 0, col: 0, cursor: this.focused };
    }
    const sel = this.focused ? editor.selection(this.s) : null;
    const rows = lay.rows.slice(this.top, this.top + shown).map(r => highlighted(r, sel));
    return { rows, row: lay.row - this.top, col: lay.col, cursor: this.focused };
  }

  private set(state: editor.EditState, reset: boolean): void {
    const changed = state.text !== this.s.text;
    this.s = state;
    this.goal = null;
    if (reset) this.undoStack = history.empty();
    if (changed && this.props.onChange !== null) this.props.onChange(state.text);
  }

  private commit(next: editor.EditState, kind: editor.EditKind): void {
    this.undoStack = history.record(this.undoStack, this.s, next, kind);
    this.set(next, false);
  }

  private history(dir: "undo" | "redo"): void {
    const step = dir === "undo" ? history.undo(this.undoStack, this.s) : history.redo(this.undoStack, this.s);
    if (step === null) return;
    this.undoStack = step.undo;
    this.set(step.state, false);
  }

  private async copy(cut: boolean): Promise<boolean> {
    const text = this.selected;
    if (text.length === 0) return false;
    if (cut) this.commit(editor.cut(this.s), "other");
    const clipboard = this.props.clipboard;
    if (clipboard === null) return true;
    const done = await clipboard.copy(text);
    if (this.props.onNote !== null) this.props.onNote(done.ok ? `${cut ? "cut" : "copied"} ${text.length} character${text.length === 1 ? "" : "s"}` : `copy failed: ${done.error}`, !done.ok);
    return true;
  }

  private async paste(): Promise<boolean> {
    const clipboard = this.props.clipboard;
    if (clipboard === null) return false;
    const read = await clipboard.paste();
    if (!read.ok) { if (this.props.onNote !== null) this.props.onNote(`paste failed: ${read.error}`, true); return true; }
    const text = cleanPaste(read.data);
    if (text.length > 0) this.commit(editor.insert(this.s, this.props.multiline ? text : text.replace(/\n/g, " ")), "other");
    return true;
  }

  private async enter(key: Key): Promise<boolean> {
    if (key.shift === true || key.alt === true || key.ctrl === true) {
      if (!this.props.multiline) return false;
      this.commit(editor.newline(this.s), "other");
      return true;
    }
    if (this.props.onSubmit === null) return false;
    await this.props.onSubmit(this.s.text);
    return true;
  }

  private vertical(dir: -1 | 1, extend: boolean): boolean {
    const goal = this.goal ?? editor.layout(this.s, this.width).col;
    if (extend) {
      this.commit(editor.extendVertical(this.s, this.width, dir, goal), "move");
      this.goal = goal;
      return true;
    }
    const base = editor.collapse(this.s, dir);
    const moved = editor.vertical(base, this.width, dir, goal);
    if (this.props.onVertical !== null && this.props.onVertical(dir, moved === null)) return true;
    if (moved === null) {
      const edge = { ...base, cursor: dir === -1 ? 0 : base.text.length };
      if (edge.cursor !== this.s.cursor || edge.anchor !== this.s.anchor) this.commit(edge, "move");
      return true;
    }
    this.commit(moved, "move");
    this.goal = goal;
    return true;
  }
}
