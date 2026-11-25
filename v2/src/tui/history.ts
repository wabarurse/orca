import type { Entry } from "../core/types";
import { editor } from "./components";

export type Browse = { entries: string[]; at: number | null };
export type Step = { browse: Browse; state: editor.EditState };

const EMPTY: editor.EditState = editor.at("");

export const browsing = (entries: string[]): Browse => ({ entries, at: null });

export function onRecalled(b: Browse, state: editor.EditState): boolean {
  return b.at !== null && b.entries[b.at] === state.text;
}

export function older(b: Browse, state: editor.EditState): Step | null {
  if (b.entries.length === 0 || b.at === 0) return null;
  if (b.at === null ? state.text.length > 0 : !onRecalled(b, state)) return null;
  const at = b.at === null ? b.entries.length - 1 : b.at - 1;
  return { browse: { entries: b.entries, at }, state: editor.at(b.entries[at] ?? "") };
}

export function newer(b: Browse): Step | null {
  if (b.at === null) return null;
  if (b.at >= b.entries.length - 1) return { browse: { entries: b.entries, at: null }, state: EMPTY };
  const at = b.at + 1;
  return { browse: { entries: b.entries, at }, state: editor.at(b.entries[at] ?? "") };
}

export function sinceClear(entries: Entry[], cleared: string | null): Entry[] {
  if (cleared === null) return entries;
  const at = entries.findIndex(entry => entry.uuid === cleared);
  return at === -1 ? entries : entries.slice(at + 1);
}
