// Logically append-only JSONL, atomically published byte-preserving file images.
// One line per entry. Entries form a tree via parentUuid;
// the conversation sent to the model is the chain from the latest leaf back
// to the root. Compaction appends a `summary` entry whose parent is the last
// message; its retained tail and the chain forward are the new context.
// history() walks past checkpoints for UI replay without duplicating retained turns.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { publish, disk, type Storage } from "./transcript-storage";
import { dirname } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type Role = "orchestrator" | "worker" | "reviewer";

export interface BaseEntry {
  uuid: string;
  parentUuid: string | null;
  ts: string;
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  message: MessageParam;
}

export interface SummaryEntry extends BaseEntry {
  type: "summary";
  text: string;
  /** Atomic context checkpoint; originals remain in the parent chain. */
  retained?: MessageParam[];
  boundary?: string | null;
}

export interface MetaEntry extends BaseEntry {
  type: "meta";
  role: Role;
  branch?: string;
  model: string;
}

/** What a turn sent the user (drained from the user's inbox when it ended), so a page can show it again where it showed live. */
export interface RepliesEntry extends BaseEntry {
  type: "replies";
  messages: { from: string; text: string }[];
}

export type Entry = MessageEntry | SummaryEntry | MetaEntry | RepliesEntry;

/** An entry as passed to append(): uuid/ts are filled in, parentUuid defaults to head(). */
export type NewEntry = Entry extends infer E
  ? E extends Entry
    ? Omit<E, "uuid" | "ts" | "parentUuid"> & { parentUuid?: string | null }
    : never
  : never;

export interface Transcript {
  path: string;
  /** Append one entry and return it with uuid/ts filled in. */
  append(entry: NewEntry, signal?: AbortSignal): Promise<Entry>;
  /** Walk from the latest leaf to the root (or latest summary) and return API messages. */
  chain(): Promise<MessageParam[]>;
  /** The entries of that walk, oldest first, the summary (if any) first: what the conversation is now. */
  branch(): Entry[];
  history?(): Entry[];
  /** uuid of the latest entry, used as parentUuid for the next append. */
  head(): string | null;
}

/** The entries from `head` back to the root or the latest summary, oldest first (a loop in the parent pointers ends the walk). */
function walk(byUuid: Map<string, Entry>, head: string | null, context = true): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let cur = head ? byUuid.get(head) : undefined;
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    entries.push(cur);
    if (context && cur.type === "summary") break;
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return entries.reverse();
}

function load(path: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as Entry;
      if (entry.uuid && entry.type) entries.set(entry.uuid, entry);
    } catch { /* Preserve damaged bytes, but never replay them. */ }
  }
  return entries;
}
function messages(entries: Entry[]): MessageParam[] {
  return entries.flatMap((e): MessageParam[] => {
    if (e.type === "summary") return [{ role: "user", content: e.text }, ...(e.retained ?? [])];
    return e.type === "message" ? [e.message] : [];
  });
}
export function open(path: string, io: Storage = disk): Transcript {
  mkdirSync(dirname(path), { recursive: true });
  const byUuid = load(path);
  let head = [...byUuid.keys()].at(-1) ?? null;
  const branch = () => walk(byUuid, head);
  async function append(partial: NewEntry, signal?: AbortSignal): Promise<Entry> {
    const entry = { ...partial, parentUuid: partial.parentUuid ?? head,
      uuid: crypto.randomUUID(), ts: new Date().toISOString() } as Entry;
    await publish(path, JSON.stringify(entry), io, () => {
      byUuid.set(entry.uuid, entry);
      head = entry.uuid;
    }, signal);
    return entry;
  }
  return { path, head: () => head, branch, append,
    history: () => walk(byUuid, head, false).filter(e => e.type !== "summary" || !e.retained),
    chain: async () => messages(branch()),
  };
}
