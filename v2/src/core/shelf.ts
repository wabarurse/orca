import { join } from "node:path";
import { z } from "zod";
import { parseJson, paths } from "../config";
import { writeAtomic } from "./conversations";
import { withStorageLock } from "./lock";

export type ShelfEntry = { archived: Record<string, string>; restored: Record<string, string> };
export type Shelf = Record<string, ShelfEntry>;

const Entry = z.object({ archived: z.record(z.string(), z.string()).default({}), restored: z.record(z.string(), z.string()).default({}) });
const ShelfFile = z.record(z.string(), Entry);
const file = (conversation: string): string => join(paths.conversation(conversation), "archived.json");
const empty = (): ShelfEntry => ({ archived: {}, restored: {} });

export const shelfKey = (plugin: string, tab: string): string => `${plugin}/${tab}`;

export async function readShelf(conversation: string): Promise<Shelf> {
  const f = Bun.file(file(conversation));
  if (!await f.exists()) return {};
  const json = parseJson(await f.text());
  const parsed = json.ok ? ShelfFile.safeParse(json.data) : null;
  return parsed !== null && parsed.success ? parsed.data : {};
}

export async function shelfEntry(conversation: string, key: string): Promise<ShelfEntry> {
  return (await readShelf(conversation))[key] ?? empty();
}

async function change(conversation: string, key: string, edit: (entry: ShelfEntry) => void): Promise<void> {
  await withStorageLock(join(paths.conversation(conversation), ".archived-lock"), async () => {
    const shelf = await readShelf(conversation);
    const entry = shelf[key] ?? empty();
    edit(entry);
    shelf[key] = entry;
    await writeAtomic(file(conversation), JSON.stringify(shelf, null, 2));
  });
}

export async function archiveItems(conversation: string, key: string, ids: string[], at: string): Promise<void> {
  if (ids.length === 0) return;
  await change(conversation, key, entry => { for (const id of ids) { entry.archived[id] = at; delete entry.restored[id]; } });
}

export async function restoreItems(conversation: string, key: string, ids: string[], at: string): Promise<void> {
  if (ids.length === 0) return;
  await change(conversation, key, entry => { for (const id of ids) { delete entry.archived[id]; entry.restored[id] = at; } });
}

export async function forgetItems(conversation: string, key: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await change(conversation, key, entry => { for (const id of ids) { delete entry.archived[id]; delete entry.restored[id]; } });
}
