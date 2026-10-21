// Rebuild a page's history from its orchestrator's transcript, like
// `claude --continue` or `codex resume`: what the page showed live, in the
// same form. User messages as "> …", agents' reports as "From <id>: …", the
// orchestrator's text as markdown blocks cut the way the stream cuts them,
// its tool calls as the dim "▸" lines agent.ts writes and its messages to the
// user labelled as replies. Tool results and thinking were never shown, so
// they stay hidden. Only the current branch shows: the parent chain from the
// head back to the root or to the latest summary (compaction), which then
// leads with a dim note. A long history keeps its last MAX_RESTORED_ROWS rows.

import { existsSync, readFileSync } from "node:fs";
import { parseFormatted } from "../inbox";
import type { Entry, MessageEntry } from "../transcript";
import { lineRows, type Line } from "./app";
import { MarkdownStream } from "./mdstream";
import { bold, dim } from "./render";

/** A restored page shows about this many rendered rows: whole messages from the newest back. */
export const MAX_RESTORED_ROWS = 200;

/** The note leading a history that a summary replaced. */
export const SUMMARIZED = dim("… earlier conversation summarized");

/** The note leading a capped history. */
export const earlier = (n: number) => dim(`… ${n} earlier ${n === 1 ? "message" : "messages"}`);

/** A user message as the page shows it when sent: "> " before the first line, the rest indented. */
export function userLines(text: string): Line[] {
  const [first, ...rest] = text.split("\n");
  return [`${bold(">")} ${first}`, ...rest.map((l) => `  ${l}`)];
}

/** An agent's message to the orchestrator: one dim line, the full report is in /agents. */
export function reportLine(from: string, text: string): Line {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const cut = first.length > 100 ? first.slice(0, 100) : first;
  const more = cut !== first || text.trim() !== first.trim();
  return dim(`From ${from}: ${cut}${more ? "…" : ""}`);
}

/** A message to the user, led by its sender. */
export const replyLine = (from: string, text: string): Line => ({ md: text, label: bold(from) });

/** A tool call as agent.ts writes it while the turn runs. */
export const toolLine = (name: string, input: unknown): string => `\x1b[2m▸ ${name} ${JSON.stringify(input).slice(0, 100)}\x1b[0m`;

/** Every entry of a transcript file, skipping blank or partial lines (as transcript.ts does). */
export function readEntries(path: string): Entry[] {
  if (!existsSync(path)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Entry); } catch { /* partial line */ }
  }
  return out;
}

/** The current branch, oldest first: from the head (the last entry) back to the root or the latest summary. */
export function currentChain(entries: Entry[]): Entry[] {
  const byUuid = new Map(entries.map((e) => [e.uuid, e]));
  const chain: Entry[] = [];
  const seen = new Set<string>();
  let cur = entries.at(-1);
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    if (cur.type === "summary") break;
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return chain.reverse();
}

type Content = Exclude<MessageEntry["message"]["content"], string>;

/** The inbox text of a user entry: its string content, or its text blocks (messages riding with tool results). */
const inboxTexts = (content: MessageEntry["message"]["content"]): string[] =>
  typeof content === "string" ? [content] : content.flatMap((b) => (b.type === "text" ? [b.text] : []));

/** Tool results by tool_use id, to tell a sent message from a refused one. */
function results(chain: Entry[]): Map<string, { ok: boolean }> {
  const out = new Map<string, { ok: boolean }>();
  for (const e of chain) {
    if (e.type !== "message" || typeof e.message.content === "string") continue;
    for (const b of e.message.content) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
      out.set(b.tool_use_id, { ok: !b.is_error && text.startsWith("sent to") });
    }
  }
  return out;
}

/**
 * The page history for a transcript, as display messages (each a run of
 * lines), oldest first. Replaying it reproduces the live page: the stream's
 * blocks end at a tool line or at the end of a turn, and the turn's messages
 * to the user follow it.
 */
export function restoreMessages(entries: Entry[]): Line[][] {
  const chain = currentChain(entries);
  const sent = results(chain);
  const out: Line[][] = [];
  const md = new MarkdownStream();
  let replies: Line[] = [];
  let cur: Line[] = [];
  const blocks = (bs: string[]) => cur.push(...bs.map((b): Line => ({ md: b, block: true })));
  const endTurn = () => {
    blocks(md.flush());
    for (const r of replies) out.push([r]);
    replies = [];
  };

  for (const e of chain) {
    if (e.type === "summary") { out.push([SUMMARIZED]); continue; }
    if (e.type !== "message") continue;
    const { role, content } = e.message;
    if (role === "user") {
      // Live, the user's own lines show when sent, before the turn reads them with any agent reports.
      const msgs = inboxTexts(content).flatMap(parseFormatted);
      const mine = (m: { from: string }) => m.from === "user" || m.from === "";
      for (const m of msgs.filter(mine)) out.push(userLines(m.text));
      for (const m of msgs.filter((m) => !mine(m))) out.push([reportLine(m.from, m.text)]);
      continue;
    }
    const parts: Content = typeof content === "string" ? [{ type: "text", text: content }] : content;
    cur = [];
    out.push(cur);
    const said = parts.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (said) { blocks(md.feed(said)); blocks(md.feed("\n")); }
    const tools = parts.filter((b) => b.type === "tool_use");
    for (const b of tools) {
      blocks(md.flush());
      cur.push(toolLine(b.name, b.input));
      const input = b.input as { to?: unknown; text?: unknown };
      if (b.name === "message" && String(input.to ?? "").trim() === "user" && sent.get(b.id)?.ok) replies.push(replyLine("orchestrator", String(input.text ?? "").trim()));
    }
    if (!tools.length) endTurn();
  }
  endTurn();
  return out.filter((m) => m.length);
}

/**
 * The page history for a transcript at `cols` columns: the newest whole
 * messages that fit in `maxRows` rendered rows (at least the newest one),
 * led by a dim count of the messages left out.
 */
export function restore(entries: Entry[], cols: number, maxRows = MAX_RESTORED_ROWS): Line[] {
  const messages = restoreMessages(entries);
  let rows = 0;
  let from = messages.length;
  while (from > 0) {
    const n = messages[from - 1]!.reduce((sum, l) => sum + lineRows(l, cols).length, 0);
    if (from < messages.length && rows + n > maxRows) break;
    rows += n;
    from--;
  }
  const dropped = messages.slice(0, from).filter((m) => m[0] !== SUMMARIZED).length;
  return [...(from > 0 ? [earlier(dropped)] : []), ...messages.slice(from).flat()];
}
