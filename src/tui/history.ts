// The input history (↑/↓) of one project, kept across restarts like Claude
// Code's history.jsonl: projects/<id>/input-history, one JSON string per line
// (an entry may span lines), newest last. Each sent line is one appendFile of
// one line, so two TUIs on the same project interleave whole entries and never
// overwrite each other. Loading keeps the newest MAX_INPUT_HISTORY entries; the
// file is rewritten (temp file + rename) to those only once it passes twice
// that many lines. Only plain messages and a few harmless commands are kept:
// never /login, a URL with credentials, or anything typed while signing in.

import { existsSync } from "node:fs";
import { appendFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "../config";

export const MAX_INPUT_HISTORY = 500;
/** The file is trimmed back to MAX_INPUT_HISTORY entries once it holds this many lines. */
export const COMPACT_AT = 2 * MAX_INPUT_HISTORY;

/** /clear is deliberately not recalled: resets always require a freshly typed command.
 * Commands safe to keep: they carry nothing secret. /new is kept unless its URL has credentials. */
const SAFE_COMMANDS = new Set(["/inbox", "/compact", "/agents", "/models", "/help", "/projects", "/review-rounds", "/back", "/close", "/quit", "/keys", "/rename", "/new", "/questions"]);

/** A URL with a user or password in it (`https://user:token@host`, `ssh://user@host`). */
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i;

/** Whether a sent line may be kept in the history (and on disk). */
export function keepable(text: string, signingIn: boolean): boolean {
  if (signingIn || !text.trim()) return false;
  if (!text.startsWith("/")) return true;
  const command = text.split(/\s/, 1)[0]!;
  return SAFE_COMMANDS.has(command) && !(command === "/new" && CREDENTIAL_URL.test(text));
}

/** `history` with `text` added last: blank text and a repeat of the last entry change nothing; the oldest entries go past the cap. */
export function remember(history: string[], text: string, max = MAX_INPUT_HISTORY): string[] {
  if (!text.trim() || history.at(-1) === text) return history;
  return [...history, text].slice(-max);
}

/** Entries of a history file, oldest first; damaged lines are skipped. */
function parse(raw: string): { entries: string[]; lines: number } {
  const entries: string[] = [];
  let lines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    try {
      const text: unknown = JSON.parse(line);
      if (typeof text === "string") entries.push(text);
    } catch { /* a damaged line */ }
  }
  return { entries, lines };
}

/** A project's saved input history: its newest MAX_INPUT_HISTORY entries, oldest first, and the file's line count. */
export async function loadHistory(project: string): Promise<{ entries: string[]; lines: number }> {
  const { entries, lines } = parse(await readFile(paths.inputHistory(project), "utf8").catch(() => ""));
  return { entries: entries.slice(-MAX_INPUT_HISTORY), lines };
}

/**
 * Add one entry to a project's history file. `lines` is how many lines the
 * file had (as far as this process knows); returns the count after. A deleted
 * project's folder is never brought back.
 */
export async function appendHistory(project: string, text: string, lines: number): Promise<number> {
  const path = paths.inputHistory(project);
  if (!existsSync(dirname(path))) return lines;
  await appendFile(path, JSON.stringify(text) + "\n");
  if (lines + 1 < COMPACT_AT) return lines + 1;
  return compact(project);
}

/** Rewrite the file to its newest MAX_INPUT_HISTORY entries, atomically. Returns the new line count. */
async function compact(project: string): Promise<number> {
  const path = paths.inputHistory(project);
  const { entries } = parse(await readFile(path, "utf8"));
  const kept = entries.slice(-MAX_INPUT_HISTORY);
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, kept.map((t) => JSON.stringify(t) + "\n").join(""));
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return kept.length;
}
