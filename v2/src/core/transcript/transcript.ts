// An agent's transcript: append-only JSONL (storage.ts appends and fsyncs each record in place), one writer per file.
// Entries link to their parent; the context sent to the model walks back from the head to the root or the latest
// summary. Readers (the TUI) refresh by reading only what was appended since their last look.
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Entry, NewEntry } from "../types";
import { publish } from "./storage";
import { paired } from "./pairs";

export type Transcript = {
  path: string;
  head: () => string | null;
  append: (entry: NewEntry) => Promise<Entry>;
  /** The current context's entries, oldest first: from the latest summary (or the root) to the head. */
  branch: () => Entry[];
  /** Every entry from the root to the head, summaries included, for the page and the archive. */
  all: () => Entry[];
  /** The messages the model gets. */
  chain: () => MessageParam[];
  /** Pick up records another process appended. */
  refresh: () => void;
};

function parse(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const entry = JSON.parse(line) as Entry;
      if (typeof entry.uuid === "string" && typeof entry.type === "string") entries.set(entry.uuid, entry);
    } catch { /* a torn last line is never replayed */ }
  }
  return entries;
}

function walk(byUuid: Map<string, Entry>, head: string | null, stopAtSummary: boolean): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  let current = head === null ? undefined : byUuid.get(head);
  while (current !== undefined && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    out.push(current);
    if (stopAtSummary && current.type === "summary") break;
    current = current.parent === null ? undefined : byUuid.get(current.parent);
  }
  return out.reverse();
}

export function contextMessages(entries: Entry[]): MessageParam[] {
  return entries.flatMap((entry): MessageParam[] => {
    if (entry.type === "summary") return [{ role: "user", content: entry.text }, ...entry.retained];
    return entry.type === "message" ? [entry.message] : [];
  });
}

export function openTranscript(path: string): Transcript {
  mkdirSync(dirname(path), { recursive: true });
  let byUuid = new Map<string, Entry>();
  let head: string | null = null;
  let size = -1;
  const refresh = (): void => {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    if (text.length === size) return;
    size = text.length;
    byUuid = parse(text);
    head = [...byUuid.keys()].at(-1) ?? null;
  };
  refresh();
  const branch = (): Entry[] => walk(byUuid, head, true);
  return {
    path,
    head: () => head,
    branch,
    all: () => walk(byUuid, head, false),
    chain: () => contextMessages(branch()),
    refresh,
    async append(partial) {
      const entry = { ...partial, uuid: crypto.randomUUID(), parent: head, ts: new Date().toISOString() } as Entry;
      await publish(path, JSON.stringify(entry), undefined, () => { byUuid.set(entry.uuid, entry); head = entry.uuid; });
      size = -1;
      return entry;
    },
  };
}

/** The last assistant batch's calls that never got a result (the process died mid-batch): each gets an error
 * result saying the outcome is unknown, so the context is valid again. Nothing is re-run. */
export async function closeInterrupted(transcript: Transcript): Promise<void> {
  const messages = transcript.chain();
  if (paired(messages)) return;
  const last = messages.findLastIndex(message => message.role === "assistant");
  const batch = messages[last];
  if (batch === undefined || typeof batch.content === "string") return;
  const answered = new Set(messages.slice(last + 1).flatMap(message => typeof message.content === "string" ? []
    : message.content.flatMap(block => block.type === "tool_result" ? [block.tool_use_id] : [])));
  const missing = batch.content.filter(block => block.type === "tool_use" && !answered.has(block.id));
  if (missing.length === 0) return;
  await transcript.append({ type: "message", inbox: [], message: { role: "user", content: missing.map(block => ({
    type: "tool_result" as const, tool_use_id: block.type === "tool_use" ? block.id : "", is_error: true,
    content: "interrupted; outcome unknown, check before retrying" })) } });
}
