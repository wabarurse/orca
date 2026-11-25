import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { MessageRecord } from "../inbox";
import { RoleRecord } from "../roles";
import type { Entry, NewEntry } from "../types";
import { publish } from "./storage";
import { paired, pairResults } from "./pairs";
import { parseJson } from "../../config";

export type Transcript = {
  path: string;
  head: () => string | null;
  append: (entry: NewEntry) => Promise<Entry>;
  branch: () => Entry[];
  all: () => Entry[];
  chain: () => MessageParam[];
  refresh: () => void;
};

const MessageShape = z.object({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]) });
const Message = z.custom<MessageParam>(value => MessageShape.safeParse(value).success);
const Base = { uuid: z.string(), parent: z.string().nullable(), ts: z.string() };
const EntryRecord: z.ZodType<Entry> = z.discriminatedUnion("type", [
  z.object({ ...Base, type: z.literal("message"), message: Message, inbox: z.array(MessageRecord) }),
  z.object({ ...Base, type: z.literal("summary"), text: z.string(), retained: z.array(Message), memory: z.object({ summary: z.array(z.string()), pending: z.array(z.string()) }).nullable() }),
  z.object({ ...Base, type: z.literal("meta"), role: RoleRecord, agent: z.string(), model: z.string(), plugins: z.array(z.string()) }),
  z.object({ ...Base, type: z.literal("replies"), messages: z.array(z.object({ from: z.string(), text: z.string() })) }),
]);

function parse(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const raw = parseJson(line);
    const entry = raw.ok ? EntryRecord.safeParse(raw.data) : null;
    if (entry !== null && entry.success) entries.set(entry.data.uuid, entry.data);
  }
  return entries;
}

function stamp(partial: NewEntry, parent: string | null): Entry {
  const base = { uuid: crypto.randomUUID(), parent, ts: new Date().toISOString() };
  switch (partial.type) {
    case "message": return { ...partial, ...base };
    case "summary": return { ...partial, ...base };
    case "meta": return { ...partial, ...base };
    case "replies": return { ...partial, ...base };
  }
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
  return pairResults(entries.flatMap((entry): MessageParam[] => {
    if (entry.type === "summary") return [{ role: "user", content: entry.text }, ...entry.retained];
    return entry.type === "message" ? [entry.message] : [];
  }));
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
      const entry = stamp(partial, head);
      await publish(path, JSON.stringify(entry), undefined, () => { byUuid.set(entry.uuid, entry); head = entry.uuid; });
      size = -1;
      return entry;
    },
  };
}

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
    type: "tool_result", tool_use_id: block.type === "tool_use" ? block.id : "", is_error: true,
    content: "interrupted; outcome unknown, check before retrying" })) } });
}
