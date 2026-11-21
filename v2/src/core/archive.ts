// Archived messages: every message a compaction replaces is indexed here first (SQLite FTS5), so `memory search`
// can still find it. Read-only for agents; the transcripts stay the record.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { paths } from "../config";
import { historicalMessages } from "./images";
import type { Transcript } from "./transcript";

let db: { file: string; handle: Database } | null = null;

function open(): Database {
  const file = paths.archive;
  if (db !== null && db.file === file) return db.handle;
  db?.handle.close();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const handle = new Database(file, { create: true, strict: true });
  handle.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL");
  handle.exec("CREATE TABLE IF NOT EXISTS messages (uuid TEXT PRIMARY KEY, conversation TEXT NOT NULL, agent TEXT NOT NULL, ts TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL)");
  handle.exec("CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text, uuid UNINDEXED, tokenize='unicode61')");
  db = { file, handle };
  return handle;
}

export function messageText(message: MessageParam): string {
  const [clean] = historicalMessages([message]);
  if (clean === undefined) return "";
  if (typeof clean.content === "string") return clean.content;
  return clean.content.map(block => {
    if (block.type === "text") return block.text;
    if (block.type === "tool_use") return `[tool ${block.name}] ${JSON.stringify(block.input)}`;
    if (block.type === "tool_result") return `[result] ${typeof block.content === "string" ? block.content : (block.content ?? []).map(item => item.type === "text" ? item.text : "").join("\n")}`;
    return "";
  }).filter(text => text.length > 0).join("\n");
}

/** Index every message of the transcript not indexed yet; idempotent. */
export async function archiveTranscript(conversation: string, agent: string, transcript: Transcript): Promise<number> {
  const handle = open();
  const known = handle.query("SELECT 1 FROM messages WHERE uuid=?");
  const insert = handle.query("INSERT INTO messages VALUES (?,?,?,?,?,?)");
  const search = handle.query("INSERT INTO message_search (text, uuid) VALUES (?,?)");
  let added = 0;
  handle.transaction(() => {
    for (const entry of transcript.all()) {
      if (entry.type !== "message" || known.get(entry.uuid) !== null) continue;
      const text = messageText(entry.message);
      if (text.length === 0) continue;
      insert.run(entry.uuid, conversation, agent, entry.ts, entry.message.role, text);
      search.run(text, entry.uuid);
      added++;
    }
  }).immediate();
  return added;
}

export type ArchiveHit = { uuid: string; conversation: string; agent: string; ts: string; role: string; snippet: string };

/** Literal-term search over archived messages of the given conversations, best first. */
export function searchArchive(conversations: string[], queries: string[], limit: number): ArchiveHit[] {
  if (conversations.length === 0) return [];
  const handle = open();
  const terms = queries.flatMap(query => query.match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, 24);
  if (terms.length === 0) return [];
  const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  const marks = conversations.map(() => "?").join(",");
  return handle.query(`SELECT m.uuid, m.conversation, m.agent, m.ts, m.role, snippet(message_search, 0, '[', ']', ' … ', 24) AS snippet
    FROM message_search JOIN messages m ON m.uuid = message_search.uuid
    WHERE message_search MATCH ? AND m.conversation IN (${marks}) ORDER BY rank LIMIT ?`).all(match, ...conversations, limit) as ArchiveHit[];
}

export function readArchived(uuid: string, offset: number, length: number): { text: string; next: number | null } | null {
  const row = open().query("SELECT text FROM messages WHERE uuid=?").get(uuid) as { text: string } | null;
  if (row === null) return null;
  const end = offset + length;
  return { text: row.text.slice(offset, end), next: end < row.text.length ? end : null };
}
