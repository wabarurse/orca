import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../config";
import { writeAtomic } from "./conversations";
import type { Delivery, Message } from "./types";

let sequence = 0;

export const MessageRecord = z.object({ id: z.string(), from: z.string(), text: z.string(), ts: z.string(),
  images: z.array(z.string()).catch([]), delivery: z.enum(["steer", "follow"]).catch("steer") });

const MessageFile = z.object({ id: z.string(), from: z.string(), text: z.string(), ts: z.string(), images: z.unknown(), delivery: z.unknown() });

const parse = (text: string): Message | null => {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  const raw = MessageFile.safeParse(json);
  if (!raw.success) return null;
  const images = Array.isArray(raw.data.images) ? raw.data.images.filter((i): i is string => typeof i === "string") : [];
  return { id: raw.data.id, from: raw.data.from, text: raw.data.text, ts: raw.data.ts, images, delivery: raw.data.delivery === "follow" ? "follow" : "steer" };
};

export async function put(conversation: string, agent: string, from: string, text: string, options: { images: string[]; delivery: Delivery }): Promise<Message> {
  const dir = paths.inbox(conversation, agent);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const message: Message = { id: crypto.randomUUID(), from, text, ts: new Date().toISOString(), images: options.images, delivery: options.delivery };
  const name = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(sequence++).toString().padStart(6, "0")}.json`;
  await writeAtomic(join(dir, name), JSON.stringify(message));
  return message;
}

export async function pending(conversation: string, agent: string, claimed = false): Promise<{ file: string; message: Message }[]> {
  const dir = paths.inbox(conversation, agent);
  const names = (await readdir(dir).catch((): string[] => [])).filter(name => name.endsWith(".json") || (claimed && name.endsWith(".taken"))).sort();
  const out: { file: string; message: Message }[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const message = parse(await Bun.file(file).text().catch(() => ""));
    if (message !== null) out.push({ file, message });
  }
  return out;
}

export async function consume(conversation: string, agent: string, seen: Set<string>, which: (message: Message) => boolean,
  commit: (messages: Message[]) => Promise<void>): Promise<Message[]> {
  const waiting = await pending(conversation, agent, true);
  const stale = waiting.filter(item => seen.has(item.message.id));
  await Promise.all(stale.map(item => rm(item.file, { force: true })));
  const taken: { file: string; message: Message }[] = [];
  for (const item of waiting) {
    if (seen.has(item.message.id)) continue;
    if (!which(item.message)) continue;
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

export function format(messages: Message[]): string {
  return messages.map(message => `[${message.from}] ${message.text}`).join("\n\n");
}

export async function withdraw(conversation: string, agent: string, id: string): Promise<Message | null> {
  for (const item of await pending(conversation, agent)) {
    if (item.message.id !== id) continue;
    await rm(item.file, { force: true });
    return item.message;
  }
  return null;
}
