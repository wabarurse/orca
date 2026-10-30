// Logically append-only JSONL, atomically published byte-preserving file images.
// One line per entry (the entry types are protocol/transcript.ts). Entries form a
// tree via parentUuid; the conversation sent to the model is the chain from the
// latest leaf back to the root. Compaction appends a `summary` entry whose parent
// is the last message; its retained tail and the chain forward are the new context.
// Explicit context-boundary entries reset model context without cutting parent links.
// history() walks past both for UI replay without duplicating retained turns.

import { paired } from "./tool-pairs";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { withStorageLock } from "../storage-lock";
import type { AppendGuard, Entry, NewEntry } from "../../../protocol";
import { publish, disk, type Storage } from "./transcript-storage";
import { dirname } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

/** Original entries in the current context epoch, including turns hidden by compaction. */
export function afterContextBoundary(entries: Entry[]): Entry[] {
  return entries.slice(entries.findLastIndex(e => e.type === "context-boundary") + 1);
}

export interface Transcript {
  path: string;
  /** Append one entry and return it with uuid/ts filled in. */
  append(entry: NewEntry, signal?: AbortSignal, guard?: AppendGuard): Promise<Entry>;
  /** Walk from the latest leaf to the root (or latest summary/context boundary) and return API messages. */
  chain(): Promise<MessageParam[]>;
  /** The entries of that walk, oldest first, the summary (if any) first, excluding the context boundary: what the conversation is now. */
  branch(): Entry[];
  history?(): Entry[];
  /** Full parent chain including checkpoints, for rebuilding the SQLite archive. */
  all?(): Entry[];
  /** uuid of the latest entry, used as parentUuid for the next append. */
  head(): string | null;
  /** Read-only snapshot replacement. Call only at a safe context boundary. */
  refresh?(): Promise<void>;
  /** Includes compacted/cleared/branched-away records: durable consumption never expires. */
  consumed?(): { deliveries: Set<string>; inputs: Set<string>; epochs: Set<string> };
}

/** The entries from `head` back to the root, latest summary or context boundary, oldest first (a loop in the parent pointers ends the walk). */
function walk(byUuid: Map<string, Entry>, head: string | null, context = true): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let cur = head ? byUuid.get(head) : undefined;
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    if (context && cur.type === "context-boundary") break;
    entries.push(cur);
    if (context && (cur.type === "summary" || cur.type === "tool-recovery")) break;
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
export function contextMessages(entries: Entry[]): MessageParam[] {
  return entries.flatMap((e): MessageParam[] => {
    if (e.type === "tool-recovery") return e.messages;
    if (e.type === "summary") return [{ role: "user", content: e.text }, ...(e.retained ?? [])];
    return e.type === "message" ? [e.message] : [];
  });
}
export function open(path: string, io: Storage = disk): Transcript {
  mkdirSync(dirname(path), { recursive: true });
  let byUuid = load(path);
  let head = [...byUuid.keys()].at(-1) ?? null;
  const branch = () => walk(byUuid, head);
  const version = () => {
    if (io !== disk) return undefined;
    try { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  };
  let observed: string | undefined;
  const reload = async () => {
    // Read/parse first: a failed refresh leaves the previous snapshot intact.
    const bytes = await io.read(path).catch(error => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    const next = new Map<string, Entry>();
    for (const line of bytes.toString().split("\n")) {
      try { const e = JSON.parse(line) as Entry; if (e.uuid && e.type) next.set(e.uuid, e); } catch { /* damaged bytes are not replayed */ }
    }
    byUuid = next;
    head = [...next.keys()].at(-1) ?? null;
    observed = version();
  };
  const lock = `${path}.lock`;
  const refresh = () => observed !== undefined && version() === observed ? Promise.resolve() : withStorageLock(lock, reload);
  async function append(partial: NewEntry, signal?: AbortSignal, guard?: AppendGuard): Promise<Entry> {
    return withStorageLock(lock, async () => {
      signal?.throwIfAborted();
      await reload(); // choose parent and publish against the SAME locked disk head
      if (guard && head !== guard.head) throw new Error("transcript changed before checkpoint publication");
      guard?.check?.();
      const entry = { ...partial, parentUuid: partial.parentUuid ?? head,
        uuid: crypto.randomUUID(), ts: new Date().toISOString() } as Entry;
      await publish(path, JSON.stringify(entry), io, () => {
        byUuid.set(entry.uuid, entry);
        head = entry.uuid;
      }, signal, guard?.check);
      observed = version();
      return entry;
    });
  }
  const consumed = () => {
    const deliveries = new Set<string>(), inputs = new Set<string>(), epochs = new Set<string>();
    for (const e of byUuid.values()) for (const m of e.inbox ?? []) {
      deliveries.add(m.deliveryId);
      if (m.from === "user" && m.inputId) inputs.add(m.inputId);
      if (m.from === "user" && m.userEpoch) epochs.add(m.userEpoch);
    }
    return { deliveries, inputs, epochs };
  };
  return { path, head: () => head, branch, append, refresh, consumed,
    all: () => walk(byUuid, head, false),
    history: () => walk(byUuid, head, false).filter(e => e.type !== "summary" || !e.retained),
    chain: async () => contextMessages(branch()),
  };
}

function corruptToolHistory(): never {
  throw new Error("invalid tool history: refusing interrupted-call recovery");
}

/** Validate the complete prefix and the final assistant batch before inspecting results. */
function finalInterruptedBatch(messages: MessageParam[]) {
  const index = messages.findLastIndex(m => m.role === "assistant");
  const batch = messages[index];
  if (!batch || !Array.isArray(batch.content) || !paired(messages.slice(0, index))) return corruptToolHistory();
  const calls = batch.content.filter(b => b.type === "tool_use");
  const ids = new Set(calls.map(b => b.id));
  if (!calls.length || ids.size !== calls.length || calls.some(b => !b.id)) return corruptToolHistory();
  return { index, calls, ids };
}

/** Each persisted result must belong to this batch and occur exactly once. */
function claimInterruptedResult(id: string, ids: Set<string>, seen: Set<string>): void {
  if (!ids.has(id) || seen.has(id)) return corruptToolHistory();
  seen.add(id);
}

/** Extract only matching results; retain all interposed user content in order. */
function interruptedTail(messages: MessageParam[], ids: Set<string>) {
  const results: Extract<Exclude<MessageParam["content"], string>[number], { type: "tool_result" }>[] = [];
  const tail: MessageParam[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") return corruptToolHistory();
    if (typeof message.content === "string") { tail.push(message); continue; }
    const rest = [];
    for (const block of message.content) {
      if (block.type !== "tool_result") { rest.push(block); continue; }
      claimInterruptedResult(block.tool_use_id, ids, seen);
      results.push(block);
    }
    if (rest.length) tail.push({ ...message, content: rest });
  }
  return { results, tail, seen };
}

/** Only an unfinished FINAL assistant batch can be recovered. Never invent an
 * outcome, execute a tool, or repair orphan/duplicate IDs or earlier corruption. */
export function interruptedMessages(messages: MessageParam[]): MessageParam[] | null {
  if (paired(messages)) return null;
  const { index, calls, ids } = finalInterruptedBatch(messages);
  const { results, tail, seen } = interruptedTail(messages.slice(index + 1), ids);
  const missing = calls.filter(b => !seen.has(b.id));
  if (!missing.length) return corruptToolHistory();
  results.push(...missing.map(b => ({ type: "tool_result" as const, tool_use_id: b.id,
    is_error: true, content: "interrupted; outcome unknown—reconcile before retrying" })));
  const recovered: MessageParam[] = [...messages.slice(0, index + 1), { role: "user", content: results }, ...tail];
  if (!paired(recovered)) return corruptToolHistory();
  return recovered;
}

/** Called only by the authorized sole-writer at a model boundary, not refresh.
 * The head guard rejects races; publication/cancellation failure sends no request. */
export async function completeInterruptedTools(transcript: Transcript, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const head = transcript.head();
  const messages = interruptedMessages(await transcript.chain());
  if (messages) await transcript.append({ type: "tool-recovery", messages }, signal, { head });
}
