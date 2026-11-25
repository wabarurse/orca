import type { Entry } from "../core/types";
import { editor } from "./components";

export type Browse = { entries: string[]; at: number | null; draft: editor.EditState };
export type Step = { browse: Browse; state: editor.EditState };

const EMPTY: editor.EditState = editor.at("");
const recalled = (text: string): editor.EditState => editor.at(text);

export const browsing = (entries: string[]): Browse => ({ entries, at: null, draft: EMPTY });

export function onRecalled(b: Browse, state: editor.EditState): boolean {
  return b.at !== null && b.entries[b.at] === state.text;
}

export function older(b: Browse, state: editor.EditState): Step | null {
  if (b.entries.length === 0 || b.at === 0) return null;
  const at = b.at === null ? b.entries.length - 1 : b.at - 1;
  const draft = b.at === null ? state : b.draft;
  return { browse: { entries: b.entries, at, draft }, state: recalled(b.entries[at] ?? "") };
}

export function newer(b: Browse): Step | null {
  if (b.at === null) return null;
  if (b.at >= b.entries.length - 1) return { browse: { entries: b.entries, at: null, draft: EMPTY }, state: b.draft };
  const at = b.at + 1;
  return { browse: { entries: b.entries, at, draft: b.draft }, state: recalled(b.entries[at] ?? "") };
}

export function sinceClear(entries: Entry[], cleared: string | null): Entry[] {
  if (cleared === null) return entries;
  const at = entries.findIndex(entry => entry.uuid === cleared);
  return at === -1 ? entries : entries.slice(at + 1);
}
