// One FIFO inbox per agent: inbox/<agent>/, a file per message, named so a directory listing is send order.
// Its one reader (the agent) consumes messages by committing them to its transcript first and removing the
// files after, so a crash in between re-reads them; the transcript's own record of consumed ids drops repeats.
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../config";
import { writeAtomic } from "./conversations";
import type { Delivery, Message } from "./types";

let sequence = 0;

const parse = (text: string): Message | null => {
  try {
    const raw = JSON.parse(text) as Partial<Message>;
    if (typeof raw.id !== "string" || typeof raw.from !== "string" || typeof raw.text !== "string" || typeof raw.ts !== "string") return null;
    return { id: raw.id, from: raw.from, text: raw.text, ts: raw.ts, images: Array.isArray(raw.images) ? raw.images.filter((i): i is string => typeof i === "string") : [],
      delivery: raw.delivery === "follow" ? "follow" : "steer" };
  } catch { return null; }
};

export async function put(conversation: string, agent: string, from: string, text: string, options: { images: string[]; delivery: Delivery }): Promise<Message> {
  const dir = paths.inbox(conversation, agent);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const message: Message = { id: crypto.randomUUID(), from, text, ts: new Date().toISOString(), images: options.images, delivery: options.delivery };
  const name = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(sequence++).toString().padStart(6, "0")}.json`;
  await writeAtomic(join(dir, name), JSON.stringify(message));
  return message;
}

/** The waiting messages, oldest first, with their files. */
export async function pending(conversation: string, agent: string, claimed = false): Promise<{ file: string; message: Message }[]> {
  const dir = paths.inbox(conversation, agent);
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(".json") || (claimed && name.endsWith(".taken"))).sort();
  const out: { file: string; message: Message }[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const message = parse(await Bun.file(file).text().catch(() => ""));
    if (message !== null) out.push({ file, message });
  }
  return out;
}

/**
 * Take the messages `which` selects (oldest first; the ones it skips stay queued, in order), hand them to
 * `commit` (which records them durably), then remove their files. `seen` holds ids already committed earlier.
 */
export async function consume(conversation: string, agent: string, seen: Set<string>, which: (message: Message) => boolean,
  commit: (messages: Message[]) => Promise<void>): Promise<Message[]> {
  const waiting = await pending(conversation, agent, true);
  const stale = waiting.filter(item => seen.has(item.message.id));
  await Promise.all(stale.map(item => rm(item.file, { force: true })));
  const taken: { file: string; message: Message }[] = [];
  for (const item of waiting) {
    if (seen.has(item.message.id)) continue;
    if (!which(item.message)) continue;
    // Claimed by rename, so a message the user withdraws at the same moment is either taken or withdrawn, never both.
    const claimedFile = item.file.endsWith(".taken") ? item.file : item.file.replace(/\.json$/, ".taken");
    if (claimedFile !== item.file && !await rename(item.file, claimedFile).then(() => true, () => false)) continue;
    taken.push({ file: claimedFile, message: item.message });
  }
  if (taken.length === 0) return [];
  const messages = taken.map(item => item.message);
  await commit(messages);
  for (const message of messages) seen.add(message.id);
  await Promise.all(taken.map(item => rm(item.file, { force: true })));
  return messages;
}

/** Messages as one user turn, each tagged with its sender. */
export function format(messages: Message[]): string {
  return messages.map(message => `[${message.from}] ${message.text}`).join("\n\n");
}

/** Remove a waiting message the user took back (Esc returns queued input to the composer). */
export async function withdraw(conversation: string, agent: string, id: string): Promise<Message | null> {
  for (const item of await pending(conversation, agent)) {
    if (item.message.id !== id) continue;
    await rm(item.file, { force: true });
    return item.message;
  }
  return null;
}
