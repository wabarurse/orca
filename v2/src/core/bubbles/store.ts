// A bubble is what a group of conversations knows in common: memory nodes, notebook pages, behavior lines,
// plugin switches and bubble-scoped plugin data, as plain files under bubbles/<id>/.
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { readConversation, saveConversation, writeAtomic } from "../conversations";
import { withStorageLock } from "../lock";

/** Plugin switches for this bubble, applied over the config's default list. */
export type PluginSwitches = { on: string[]; off: string[] };
export type Bubble = { id: string; name: string; createdAt: string; plugins: PluginSwitches };
const ID = /^bubble-[a-f0-9]{8}$/;

export function bubbleDir(id: string): string {
  if (!ID.test(id)) throw new Error(`invalid bubble id ${JSON.stringify(id)}`);
  return join(paths.bubbles, id);
}
export const writeFileAtomic = writeAtomic;
export async function readJson<T>(file: string, missing: T): Promise<T> {
  const f = Bun.file(file);
  return await f.exists() ? await f.json() as T : missing;
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export async function readBubble(id: string): Promise<Bubble | null> {
  if (!ID.test(id)) return null;
  const raw = await readJson<Partial<Bubble> & { plugins?: Partial<PluginSwitches> } | null>(join(bubbleDir(id), "bubble.json"), null);
  if (raw === null || typeof raw.name !== "string") return null;
  return { id, name: raw.name, createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "", plugins: { on: strings(raw.plugins?.on), off: strings(raw.plugins?.off) } };
}

async function writeBubble(bubble: Bubble): Promise<void> {
  await mkdir(bubbleDir(bubble.id), { recursive: true });
  await writeFileAtomic(join(bubbleDir(bubble.id), "bubble.json"), JSON.stringify(bubble, null, 2));
}

/** The conversation's bubble id, or null when it has none yet. Never creates one. */
export async function peekBubble(conversation: string): Promise<string | null> {
  return (await readConversation(conversation))?.bubble ?? null;
}

/** The conversation's bubble, created on first use and named after the conversation. */
export async function ensureBubble(conversation: string): Promise<Bubble> {
  return withStorageLock(join(paths.runtime, "bubble-locks", conversation), async () => {
    const current = await readConversation(conversation);
    if (current === null) throw new Error(`no conversation ${conversation}`);
    const existing = current.bubble === null ? null : await readBubble(current.bubble);
    if (existing !== null) return existing;
    const bubble: Bubble = { id: current.bubble ?? `bubble-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, name: current.name, createdAt: new Date().toISOString(), plugins: { on: [], off: [] } };
    await writeBubble(bubble);
    await saveConversation({ ...current, bubble: bubble.id });
    return bubble;
  });
}

export async function joinBubble(conversation: string, id: string): Promise<Bubble> {
  const bubble = await readBubble(id);
  if (bubble === null) throw new Error(`no bubble ${id}`);
  const current = await readConversation(conversation);
  if (current === null) throw new Error(`no conversation ${conversation}`);
  await saveConversation({ ...current, bubble: id });
  return bubble;
}

export async function listBubbles(): Promise<Bubble[]> {
  const names = await readdir(paths.bubbles).catch(() => [] as string[]);
  const found = await Promise.all(names.filter(name => ID.test(name)).map(readBubble));
  return found.filter((b): b is Bubble => b !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** Switch a plugin on or off for one bubble; `null` returns it to the config default. */
export async function setBubblePlugin(id: string, plugin: string, state: "on" | "off" | null): Promise<Bubble> {
  return withStorageLock(join(bubbleDir(id), ".plugins-lock"), async () => {
    const bubble = await readBubble(id);
    if (bubble === null) throw new Error(`no bubble ${id}`);
    const on = bubble.plugins.on.filter(name => name !== plugin), off = bubble.plugins.off.filter(name => name !== plugin);
    if (state === "on") on.push(plugin);
    if (state === "off") off.push(plugin);
    const next = { ...bubble, plugins: { on, off } };
    await writeBubble(next);
    return next;
  });
}

export async function removeBubble(id: string): Promise<void> {
  await rm(bubbleDir(id), { recursive: true, force: true });
}
