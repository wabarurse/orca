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

export type Entry = MessageEntry | SummaryEntry | MetaEntry;

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
  /** uuid of the latest entry, used as parentUuid for the next append. */
  head(): string | null;
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

  return {
    path,
    head: () => head,

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
      const messages: MessageParam[] = [];
      let cur = head ? byUuid.get(head) : undefined;
      while (cur) {
        if (cur.type === "summary") {
          messages.push({ role: "user", content: cur.text });
          break;
        }
        if (cur.type === "message") messages.push(cur.message);
        cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
      }
      return messages.reverse();
    },
  };
}
