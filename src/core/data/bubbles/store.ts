// A bubble is what a group of orchestrators knows in common: memory nodes, notebook pages and behavior lines,
// stored as plain files under `~/.orca/bubbles/<id>/` so any tool can read them. A conversation belongs to exactly
// one bubble (project state key `bubble`); one that never joined or wrote anything has none yet and is listed as
// a bubble of one. Transcripts, tasks, agents, questions and images stay with their conversation.
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { conversationIds, paths, readProjectState, writeProjectState } from "../../../config";
import { withStorageLock } from "../storage-lock";

export interface Bubble { id: string; name: string; createdAt: string }
const ID = /^bubble-[a-f0-9]{8}$/;

export function bubbleDir(id: string): string {
  if (!ID.test(id)) throw new Error(`invalid bubble id ${JSON.stringify(id)}`);
  return join(paths.bubbles, id);
}
/** Atomic replace: a reader sees the old file or the new one, never a partial write. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temp, text);
  await rename(temp, file);
}
export async function readJson<T>(file: string, missing: T): Promise<T> {
  const f = Bun.file(file);
  return await f.exists() ? await f.json() as T : missing;
}
/** The bubble a conversation belongs to, or null when it has none yet. Never creates one. */
export function peekBubble(project: string): string | null {
  const id = readProjectState<string>(project, "bubble");
  return typeof id === "string" && ID.test(id) ? id : null;
}
export async function readBubble(id: string): Promise<Bubble | null> {
  return readJson<Bubble | null>(join(bubbleDir(id), "bubble.json"), null);
}
/** The conversation's bubble, created on first use and named after the conversation. */
export async function ensureBubble(project: string, name = project): Promise<Bubble> {
  return withStorageLock(join(paths.runtime, "bubble-locks", project), async () => {
    const current = peekBubble(project), existing = current ? await readBubble(current) : null;
    if (existing) return existing;
    const bubble: Bubble = { id: current ?? `bubble-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, name, createdAt: new Date().toISOString() };
    await mkdir(bubbleDir(bubble.id), { recursive: true });
    await writeFileAtomic(join(bubbleDir(bubble.id), "bubble.json"), JSON.stringify(bubble));
    writeProjectState(project, "bubble", bubble.id);
    return bubble;
  });
}
/** Attach a conversation to an existing bubble: from then on it reads and writes that bubble's knowledge. */
export async function joinBubble(project: string, id: string): Promise<Bubble> {
  const bubble = await readBubble(id);
  if (!bubble) throw new Error(`no bubble ${id}`);
  writeProjectState(project, "bubble", id);
  return bubble;
}
export async function renameBubble(id: string, name: string): Promise<void> {
  const bubble = await readBubble(id);
  if (!bubble) throw new Error(`no bubble ${id}`);
  await writeFileAtomic(join(bubbleDir(id), "bubble.json"), JSON.stringify({ ...bubble, name }));
}
/** The conversations attached to a bubble, by id. */
export function bubbleMembers(id: string): string[] {
  return conversationIds(paths.root).filter(project => { try { return peekBubble(project) === id; } catch { return false; } });
}
export async function listBubbles(): Promise<Bubble[]> {
  const names = await readdir(paths.bubbles).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error; });
  const found = await Promise.all(names.filter(name => ID.test(name)).map(readBubble));
  return found.filter((b): b is Bubble => b !== null).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
/** A conversation leaves its bubble (it was deleted): the bubble's files go with its last member. */
export async function leaveBubble(project: string): Promise<{ bubble: string; removed: boolean } | null> {
  const id = peekBubble(project);
  if (!id) return null;
  const left = bubbleMembers(id).filter(member => member !== project);
  if (left.length === 0) await rm(bubbleDir(id), { recursive: true, force: true });
  return { bubble: id, removed: left.length === 0 };
}
