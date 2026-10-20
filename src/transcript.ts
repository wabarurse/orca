// Append-only JSONL, one line per entry. Entries form a tree via parentUuid;
// the conversation sent to the model is the chain from the latest leaf back
// to the root. Compaction appends a `summary` entry whose parent is the last
// message; the chain from there forward is the new context.

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
  taskId?: string;
  model: string;
}

export type Entry = MessageEntry | SummaryEntry | MetaEntry;

export interface Transcript {
  path: string;
  /** Append one entry and return it with uuid/ts filled in. */
  append(entry: Omit<Entry, "uuid" | "ts">): Promise<Entry>;
  /** Walk from the latest leaf to the root (or latest summary) and return API messages. */
  chain(): Promise<MessageParam[]>;
  /** uuid of the latest entry, used as parentUuid for the next append. */
  head(): string | null;
}

// TODO(PR1): implement open(path): Transcript backed by the JSONL file.
export function open(_path: string): Transcript {
  throw new Error("transcript: not implemented");
}
