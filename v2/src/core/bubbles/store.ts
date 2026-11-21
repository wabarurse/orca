import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../../config";
import { readConversation, saveConversation, writeAtomic } from "../conversations";
import { withStorageLock } from "../lock";
import { fail, ok, parseJson, type Result } from "../result";

export type PluginSwitches = { on: string[]; off: string[] };
export type Bubble = { id: string; name: string; createdAt: string; plugins: PluginSwitches };
const ID = /^bubble-[a-f0-9]{8}$/;

export function bubbleDir(id: string): string {
  if (!ID.test(id)) throw new Error(`invalid bubble id ${JSON.stringify(id)}`);
  return join(paths.bubbles, id);
}
export const writeFileAtomic = writeAtomic;

export async function readJson(file: string): Promise<Result<unknown>> {
  const f = Bun.file(file);
  if (!await f.exists()) return ok(null);
  const parsed = parseJson(await f.text());
  return parsed.ok ? parsed : fail(`${file} is not valid JSON: ${parsed.error}`);
}

export function rows<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row: unknown) => { const parsed = schema.safeParse(row); return parsed.success ? [parsed.data] : []; });
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const BubbleFile = z.object({ name: z.string(), createdAt: z.unknown(), plugins: z.object({ on: z.unknown(), off: z.unknown() }).partial().nullish() });

export async function readBubble(id: string): Promise<Bubble | null> {
  if (!ID.test(id)) return null;
  const json = await readJson(join(bubbleDir(id), "bubble.json"));
  if (!json.ok) return null;
  const raw = BubbleFile.safeParse(json.data);
  if (!raw.success) return null;
  return { id, name: raw.data.name, createdAt: typeof raw.data.createdAt === "string" ? raw.data.createdAt : "",
    plugins: { on: strings(raw.data.plugins?.on), off: strings(raw.data.plugins?.off) } };
}

async function writeBubble(bubble: Bubble): Promise<void> {
  await mkdir(bubbleDir(bubble.id), { recursive: true });
  await writeFileAtomic(join(bubbleDir(bubble.id), "bubble.json"), JSON.stringify(bubble, null, 2));
}

export async function peekBubble(conversation: string): Promise<string | null> {
  return (await readConversation(conversation))?.bubble ?? null;
}

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

export async function joinBubble(conversation: string, id: string): Promise<Result<Bubble>> {
  const bubble = await readBubble(id);
  if (bubble === null) return fail(`no bubble ${id}`);
  const current = await readConversation(conversation);
  if (current === null) return fail(`no conversation ${conversation}`);
  await saveConversation({ ...current, bubble: id });
  return ok(bubble);
}

export async function listBubbles(): Promise<Bubble[]> {
  const names = await readdir(paths.bubbles).catch((): string[] => []);
  const found = await Promise.all(names.filter(name => ID.test(name)).map(readBubble));
  return found.filter((b): b is Bubble => b !== null).sort((a, b) => a.name.localeCompare(b.name));
}

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
