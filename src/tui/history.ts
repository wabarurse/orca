// The input history (↑/↓) of one project, kept across restarts like Claude
// Code's history.jsonl: projects/<id>/input-history, one JSON string per line
// (an entry may span lines), newest last, at most MAX_INPUT_HISTORY entries.
// Written whole and atomically (temp file + rename), so a crash leaves the old
// file or the new one, never half of either.

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "../config";

export const MAX_INPUT_HISTORY = 500;

/** `history` with `text` added last: blank text and a repeat of the last entry change nothing; the oldest entries go past the cap. */
export function remember(history: string[], text: string, max = MAX_INPUT_HISTORY): string[] {
  if (!text.trim() || history.at(-1) === text) return history;
  return [...history, text].slice(-max);
}

/** A project's saved input history, oldest first; unreadable lines are skipped. */
export async function loadHistory(project: string): Promise<string[]> {
  const raw = await readFile(paths.inputHistory(project), "utf8").catch(() => "");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const text: unknown = JSON.parse(line);
      if (typeof text === "string") out.push(text);
    } catch { /* a damaged line */ }
  }
  return out.slice(-MAX_INPUT_HISTORY);
}

/** Replace a project's saved input history, atomically; a deleted project's folder is not brought back. */
export async function saveHistory(project: string, history: string[]): Promise<void> {
  const path = paths.inputHistory(project);
  if (!existsSync(dirname(path))) return;
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, history.map((t) => JSON.stringify(t) + "\n").join(""));
  await rename(tmp, path);
}
