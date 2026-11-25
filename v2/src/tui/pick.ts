import type { PickOptions } from "../core/plugins/types";
import type { Key } from "./components";
import { bold, dim, fit, plainText, selectionMarks } from "./components";

export type PickState = { title: string; options: string[]; current: number | null; index: number; digits: boolean };
export type PickStep = { kind: "move"; state: PickState } | { kind: "done"; index: number | null } | { kind: "ignored" };

const inRange = (n: number | null | undefined, count: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < count;

export function pickStart(title: string, options: string[], opts: PickOptions | undefined): PickState {
  const current = inRange(opts?.current, options.length) ? opts.current : null;
  return { title, options, current, index: current ?? 0, digits: opts?.digits === true };
}

export function pickKey(state: PickState, key: Key): PickStep {
  const last = state.options.length - 1;
  const move = (index: number): PickStep => ({ kind: "move", state: { ...state, index: Math.max(0, Math.min(last, index)) } });
  if (key.name === "escape") return { kind: "done", index: null };
  if (key.name === "enter") return { kind: "done", index: state.options.length === 0 ? null : state.index };
  if (key.name === "up" || (key.name === "char" && key.text === "k")) return move(state.index - 1);
  if (key.name === "down" || (key.name === "char" && key.text === "j")) return move(state.index + 1);
  if (key.name === "home") return move(0);
  if (key.name === "end") return move(last);
  if (state.digits && key.name === "char" && key.text !== undefined && /^[1-9]$/.test(key.text)) {
    const index = Number(key.text) - 1;
    return index <= last ? { kind: "done", index } : { kind: "ignored" };
  }
  return { kind: "ignored" };
}

export function pickHint(state: PickState): string {
  const digits = state.digits && state.options.length > 0 ? ` · 1-${Math.min(9, state.options.length)} picks` : "";
  return `${state.title}   ↑↓ enter${digits}   esc cancels`;
}

const highlight = (s: string): string => { const marks = selectionMarks(); return `\x1b[1m${marks.on}${s}${marks.off}\x1b[0m`; };

export function pickRows(state: PickState, cols: number, max: number): string[] {
  const count = state.options.length;
  if (count === 0) return [dim("  no choices")];
  const room = Math.max(1, count > max ? max - 1 : max);
  const start = Math.max(0, Math.min(state.index - room + 1, count - room));
  const marks = state.current !== null;
  const width = String(Math.min(count, 9)).length;
  const rows = state.options.slice(start, start + room).map((option, i) => {
    const at = start + i;
    const digit = state.digits ? `${at < 9 ? String(at + 1).padStart(width) : " ".repeat(width)} ` : "";
    const text = `${digit}${marks ? `${at === state.current ? "●" : " "} ` : ""}${plainText(option)}`;
    return at === state.index ? fit(`${bold("❯")} ${highlight(fit(text, Math.max(1, cols - 2)))}`, cols) : fit(`  ${text}`, cols);
  });
  return count > room ? [...rows, dim(`${state.index + 1} of ${count}`)] : rows;
}
