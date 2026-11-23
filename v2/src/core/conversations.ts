import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { z } from "zod";
import { fail, ok, paths, type Result } from "../config";

export type Conversation = {
  id: string;
  name: string;
  directory: string;
  bubble: string | null;
  noBubble: boolean;
  model: string | null;
  effort: string | null;
  fast: boolean;
  createdAt: string;
};

const ID = /^c-[a-f0-9]{8}$/;

const ConversationFile = z.object({ name: z.string(), directory: z.string(), createdAt: z.string(), bubble: z.unknown(), noBubble: z.boolean().default(false), model: z.unknown(), effort: z.unknown(), fast: z.boolean().default(false) });

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
  let json: unknown;
  try { json = JSON.parse(await file.text()); } catch { return null; }
  const raw = ConversationFile.safeParse(json);
  if (!raw.success) return null;
  return { id, name: raw.data.name, directory: raw.data.directory, bubble: typeof raw.data.bubble === "string" ? raw.data.bubble : null, noBubble: raw.data.noBubble,
    model: typeof raw.data.model === "string" ? raw.data.model : null,
    effort: typeof raw.data.effort === "string" ? raw.data.effort : null, fast: raw.data.fast, createdAt: raw.data.createdAt };
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await mkdir(paths.conversation(conversation.id), { recursive: true, mode: 0o700 });
  await writeAtomic(paths.meta(conversation.id), JSON.stringify(conversation, null, 2));
}

export async function createConversation(directory: string, name: string | null): Promise<Conversation> {
  const id = `c-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const conversation: Conversation = { id, name: name ?? id, directory, bubble: null, noBubble: false, model: null, effort: null, fast: false, createdAt: new Date().toISOString() };
  await saveConversation(conversation);
  return conversation;
}

export async function listConversations(): Promise<Conversation[]> {
  const names = await readdir(paths.conversations).catch((): string[] => []);
  const found = await Promise.all(names.filter(validId).map(readConversation));
  return found.filter((c): c is Conversation => c !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function conversationFor(directory: string): Promise<Conversation> {
  const existing = (await listConversations()).find(c => c.directory === directory);
  return existing ?? createConversation(directory, null);
}

export async function deleteConversation(id: string): Promise<Result<null>> {
  if (!validId(id)) return fail(`invalid conversation id ${JSON.stringify(id)}`);
  await rm(paths.conversation(id), { recursive: true, force: true });
  await rm(paths.worktrees(id), { recursive: true, force: true });
  return ok(null);
}
