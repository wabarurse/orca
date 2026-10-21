// Append-only JSONL, one line per entry. Entries form a tree via parentUuid;
// the conversation sent to the model is the chain from the latest leaf back
// to the root. Compaction appends a `summary` entry whose parent is the last
// message; the chain from there forward is the new context.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
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
  append(entry: NewEntry): Promise<Entry>;
  /** Walk from the latest leaf to the root (or latest summary) and return API messages. */
  chain(): Promise<MessageParam[]>;
  /** The entries of that walk, oldest first, the summary (if any) first: what the conversation is now. */
  branch(): Entry[];
  /** uuid of the latest entry, used as parentUuid for the next append. */
  head(): string | null;
}

/** The entries from `head` back to the root or the latest summary, oldest first (a loop in the parent pointers ends the walk). */
function walk(byUuid: Map<string, Entry>, head: string | null): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let cur = head ? byUuid.get(head) : undefined;
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    entries.push(cur);
    if (cur.type === "summary") break;
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return entries.reverse();
}

export function open(path: string): Transcript {
  mkdirSync(dirname(path), { recursive: true });
  const byUuid = new Map<string, Entry>();
  let head: string | null = null;

  // Eager load. A partial last line (crash mid-write) is dropped, not fatal.
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      byUuid.set(entry.uuid, entry);
      head = entry.uuid;
    }
  }

  const branch = () => walk(byUuid, head);

  return {
    path,
    head: () => head,
    branch,

    async append(partial) {
      const entry = {
        ...partial,
        parentUuid: partial.parentUuid ?? head,
        uuid: crypto.randomUUID(),
        ts: new Date().toISOString(),
      } as Entry;
      await appendFile(path, JSON.stringify(entry) + "\n");
      byUuid.set(entry.uuid, entry);
      head = entry.uuid;
      return entry;
    },

    async chain() {
      return branch().flatMap((e): MessageParam[] => {
        if (e.type === "summary") return [{ role: "user", content: e.text }];
        return e.type === "message" ? [e.message] : [];
      });
    },
  };
}
