import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseJson, paths } from "../config";
import { writeAtomic } from "./conversations";
import { withStorageLock } from "./lock";

export const INPUT_HISTORY_LIMIT = 500;

const HistoryFile = z.array(z.string());
const file = (conversation: string): string => join(paths.conversation(conversation), "input-history.json");

export function remember(entries: string[], text: string, limit = INPUT_HISTORY_LIMIT): string[] {
  if (text.trim().length === 0 || entries.at(-1) === text) return entries.slice(-limit);
  return [...entries, text].slice(-limit);
}

export async function readInputHistory(conversation: string): Promise<string[]> {
  const f = Bun.file(file(conversation));
  if (!await f.exists()) return [];
  const json = parseJson(await f.text());
  const parsed = json.ok ? HistoryFile.safeParse(json.data) : null;
  return parsed !== null && parsed.success ? parsed.data.slice(-INPUT_HISTORY_LIMIT) : [];
}

export async function recordInput(conversation: string, text: string): Promise<string[]> {
  await mkdir(paths.conversation(conversation), { recursive: true, mode: 0o700 });
  return withStorageLock(join(paths.conversation(conversation), ".input-history-lock"), async () => {
    const entries = remember(await readInputHistory(conversation), text);
    await writeAtomic(file(conversation), JSON.stringify(entries));
    return entries;
  });
}
