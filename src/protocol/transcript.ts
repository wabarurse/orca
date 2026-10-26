// The transcript's entry types (core/data/transcripts/transcript.ts writes and
// walks them; the TUI's restore, app and view read them). Entries form a tree via
// parentUuid: see transcript.ts for how the conversation is walked.

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Message } from "./inbox";

export type Role = "orchestrator" | "worker" | "reviewer";

export interface BaseEntry {
  uuid: string;
  parentUuid: string | null;
  ts: string;
  /** Inbox file identities committed atomically with context/replies, never model-visible. */
  inbox?: (Message & { deliveryId: string })[];
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  message: MessageParam;
}

/** The orchestrator's rolling memory, as a summary entry carries it (memory/rolling-summary.ts maintains it). */
export interface RollingMemory {
  user: string[];
  project: string[];
  pending: string[];
  tasks: { id: string; notes: string }[];
}

export interface SummaryEntry extends BaseEntry {
  type: "summary";
  text: string;
  /** Atomic context checkpoint; originals remain in the parent chain. */
  retained?: MessageParam[];
  boundary?: string | null;
  /** Reusable structured memory, distinct from the verbatim recent tail. */
  memory?: RollingMemory;
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

/** Explicit reset of model context, not a message or summary. Parent preserves full history. */
export interface ContextBoundaryEntry extends BaseEntry {
  type: "context-boundary";
}

export type Entry = MessageEntry | SummaryEntry | MetaEntry | RepliesEntry | ContextBoundaryEntry;

/** An entry as passed to append(): uuid/ts are filled in, parentUuid defaults to head(). */
export type NewEntry = Entry extends infer E
  ? E extends Entry
    ? Omit<E, "uuid" | "ts" | "parentUuid"> & { parentUuid?: string | null }
    : never
  : never;

/** Checkpoints are conditional on the snapshot used to build their retained tail.
 * check runs again immediately before publication (e.g. shared cancellation epoch).
 */
export interface AppendGuard { head: string | null; check?(): void }

