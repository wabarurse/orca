import type { EditKind, EditState } from "./editor";

export type Undo = { past: EditState[]; future: EditState[]; last: EditKind | null };

export const UNDO_LIMIT = 200;

export const empty = (): Undo => ({ past: [], future: [], last: null });

function joins(last: EditKind | null, kind: EditKind): boolean {
  if (last === null) return false;
  if (kind === "type") return last === "type";
  if (kind === "space") return last === "type" || last === "space";
  if (kind === "delete-back" || kind === "delete-forward") return last === kind;
  return false;
}

export function record(u: Undo, before: EditState, after: EditState, kind: EditKind): Undo {
  if (kind === "move" || before.text === after.text) return { ...u, last: null };
  if (joins(u.last, kind) && before.anchor === null) return { past: u.past, future: [], last: kind };
  return { past: [...u.past, before].slice(-UNDO_LIMIT), future: [], last: kind };
}

export function undo(u: Undo, current: EditState): { undo: Undo; state: EditState } | null {
  const state = u.past.at(-1);
  if (state === undefined) return null;
  return { undo: { past: u.past.slice(0, -1), future: [...u.future, current], last: null }, state };
}

export function redo(u: Undo, current: EditState): { undo: Undo; state: EditState } | null {
  const state = u.future.at(-1);
  if (state === undefined) return null;
  return { undo: { past: [...u.past, current], future: u.future.slice(0, -1), last: null }, state };
}
