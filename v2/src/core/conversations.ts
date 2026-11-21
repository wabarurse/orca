// A conversation: one orchestrator, its workers, and everything they keep under conversations/<id>/.
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { paths } from "../config";

export type Conversation = {
  id: string;
  name: string;
  /** The folder it works in (a checkout or any directory). */
  directory: string;
  /** The bubble it shares memory, notebook, behavior and plugin switches with; null until it first needs one. */
  bubble: string | null;
  /** The model this conversation uses; null follows config.toml. */
  model: string | null;
  createdAt: string;
};

const ID = /^c-[a-f0-9]{8}$/;

export function validId(id: string): boolean {
  return ID.test(id);
}

export async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temp, text);
  await rename(temp, file);
}

export async function readConversation(id: string): Promise<Conversation | null> {
  if (!validId(id)) return null;
  const file = Bun.file(paths.meta(id));
  if (!(await file.exists())) return null;
  const raw = await file.json() as Partial<Conversation>;
  if (typeof raw.name !== "string" || typeof raw.directory !== "string" || typeof raw.createdAt !== "string") return null;
  return { id, name: raw.name, directory: raw.directory, bubble: typeof raw.bubble === "string" ? raw.bubble : null,
    model: typeof raw.model === "string" ? raw.model : null, createdAt: raw.createdAt };
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await mkdir(paths.conversation(conversation.id), { recursive: true, mode: 0o700 });
  await writeAtomic(paths.meta(conversation.id), JSON.stringify(conversation, null, 2));
}

export async function createConversation(directory: string, name: string | null): Promise<Conversation> {
  const id = `c-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const conversation: Conversation = { id, name: name ?? id, directory, bubble: null, model: null, createdAt: new Date().toISOString() };
  await saveConversation(conversation);
  return conversation;
}

export async function listConversations(): Promise<Conversation[]> {
  const names = await readdir(paths.conversations).catch(() => [] as string[]);
  const found = await Promise.all(names.filter(validId).map(readConversation));
  return found.filter((c): c is Conversation => c !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The newest conversation in this folder, or a new one. */
export async function conversationFor(directory: string): Promise<Conversation> {
  const existing = (await listConversations()).find(c => c.directory === directory);
  return existing ?? createConversation(directory, null);
}

/** Removes the conversation's folder (its transcripts, inboxes, logs and `$ORCA_DATA`) and its worktrees.
 * The bubble and global data stay; the caller stops its agents first. */
export async function deleteConversation(id: string): Promise<void> {
  if (!validId(id)) throw new Error(`invalid conversation id ${JSON.stringify(id)}`);
  await rm(paths.conversation(id), { recursive: true, force: true });
  await rm(paths.worktrees(id), { recursive: true, force: true });
}
