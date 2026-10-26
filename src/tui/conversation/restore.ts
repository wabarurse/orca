import { imageLabels } from "../../core/data/images";
import type { Message } from "../../protocol";
// Rebuild a page's history from its orchestrator's transcript, like
// `claude --continue` or `codex resume`: what the page showed live, in the
// same form. User messages as "> …", agents' messages as "From <id>: …", the
// orchestrator's text as markdown blocks cut the way the stream cuts them,
// its tool calls as the "⏺ Bash(…)" line and "⎿ summary" each showed when it
// ended (paired with its tool_result by id, through the same toolview.ts
// formatter; a call with no result shows failed "interrupted"), and what each turn
// sent the user (the transcript's `replies` entries) labelled after that
// turn. Full tool results and thinking were never shown, so they stay hidden.
// The caller chooses the entries: full Transcript.history() for the UI, or a
// model branch (which can lead with a summary). The live UI uses Infinity so
// every original message remains scrollable; finite budgets are explicit previews.
//
// Known differences from the live page:
// - A user message typed mid-turn showed live where it was typed; restored, it
//   sits where the orchestrator read it (with the user's lines first in that
//   inbox batch, as typed lines show before the turn reads them).
// - Transcripts from before `replies` entries existed only hold the
//   orchestrator's own `message` calls to the user: those are held until the
//   user next speaks (or the end), so a reply from an earlier turn that ended
//   without the user speaking shows later than it did live, and worker or
//   reviewer messages to "user" (not in the orchestrator's transcript) are lost.
// - "user" messages that did not come from the TUI (`orca msg`) show as
//   "> …" both live and restored.
// - A settled question leaves no line. An answer (or a legacy delivered skip)
//   is a "user" message in the transcript (questions.ts: `[<id>] answer to
//   "…": …`), recognized by its question id and left out, live (when the
//   orchestrator reads it) and restored alike; the page showed it as a
//   transient note when it was answered here, and the prompt queue showed the
//   answer until the orchestrator read it. Questions still open are not in the
//   transcript: the Ctrl+Q queue shows them from questions/, where answered
//   and skipped files are kept too. Silent skips only update questions/.
// - Errors, command output (/help, /agents, …), page notices ("queued; runs
//   after sign-in") and anything else the app itself said are not in the
//   transcript and are not restored. Informational status notes ("model set
//   to …", a rename, "orchestrator was not running; restarted", an answered or
//   skipped question) are not even page lines: App shows them as one transient
//   row above the composer (`App.note`).

import { parseFormatted } from "../../protocol";
import type { Entry, MessageEntry } from "../../protocol";
import { interruptedView, toolView, type ToolOutcome } from "../../protocol";
import { historyRows, type Line } from "./lines";
import { MarkdownStream } from "./mdstream";
import { bold, dim, wrap } from "../components";

/** Default budget for bounded previews; the live page explicitly restores all rows. */
export const MAX_RESTORED_ROWS = 200;

/** The note leading a history that a summary replaced. */
export const SUMMARIZED = dim("… earlier conversation summarized");

/** The note leading a capped history. */
export const earlier = (n: number) => dim(`… ${n} earlier ${n === 1 ? "message" : "messages"}`);

/** A user message as the page shows it when sent: "> " before the first line, the rest indented, all on the user background. */
export function userLines(text: string): Line[] {
  const [first, ...rest] = text.split("\n");
  return [`${bold(">")} ${first}`, ...rest.map((l) => `  ${l}`)].map((user) => ({ user }));
}

/** A question id as questions.ts makes them: its ask time, a sequence number and a random suffix. */
const QUESTION_ID = String.raw`\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-\d{6}-[0-9a-f]{8}`;
/** A delivered answer or legacy skip (questions.ts): one line, led by the question's id. */
const REPLY = new RegExp(`^\\[${QUESTION_ID}\\] (?:answer to|skipped) "[^\\n]*$`);

/** Whether a "user" message is a question's answer or skip (questions.ts), by its id; chat text is never one. */
export const questionReply = (text: string): boolean => REPLY.test(text);

/** A message from the user as the page shows it: "> …", or nothing for a settled question's reply. */
export const fromUserLines = (text: string): Line[] => (questionReply(text) ? [] : userLines(text));

const REPORT_CHARS = 100;

/** An agent's message to the orchestrator: one dim line (its first, cut at 100 characters); the full report is in /agents. */
export function reportLine(from: string, text: string): Line {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const chars = [...first];
  const cut = chars.slice(0, REPORT_CHARS).join("");
  const more = chars.length > REPORT_CHARS || text.trim() !== first.trim();
  return dim(`from ${from}: ${cut}${more ? "…" : ""}`);
}

/** A message to the user, led by its sender. */
export const replyLine = (from: string, text: string): Line => ({ md: text, label: bold(from) });

/** One message as the page shows it, laid out only when needed. */
interface Item { lines: () => Line[]; summary?: boolean }

const now = (lines: Line[]): Item => ({ lines: () => lines });

type Content = Exclude<MessageEntry["message"]["content"], string>;
type Block = Content[number];

/** The text of a tool result. */
const resultText = (b: Extract<Block, { type: "tool_result" }>): string =>
  typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");

/** The tool results in an entry. */
const toolResults = (e: Entry) =>
  e.type === "message" && typeof e.message.content !== "string" ? e.message.content.filter((b) => b.type === "tool_result") : [];

/** Every tool result in the branch by its tool_use id, as the call's outcome. */
function outcomes(chain: Entry[]): Map<string, ToolOutcome> {
  return new Map(chain.flatMap(toolResults).map((b) => [b.tool_use_id, { id: b.tool_use_id, ok: !b.is_error, text: resultText(b) }]));
}

/** A call as it ended, or failed "interrupted" when it never got one (the run stopped mid-call); none while the turn still runs it (`omit`: the live view shows it running). */
function callLine(b: Extract<Block, { type: "tool_use" }>, results: Map<string, ToolOutcome>, omit?: Set<string>): Line | null {
  const outcome = results.get(b.id);
  if (!outcome && omit?.has(b.id)) return null;
  return outcome ? toolView(b.name, b.input, outcome) : interruptedView(b.name, b.input);
}

/**
 * The newest assistant entry's calls without a result. While the turn runs
 * they are running (the daemon appends their results when the batch ends);
 * once it does not, they were interrupted.
 */
export function unresolvedCalls(chain: Entry[]): Set<string> {
  const last = chain.findLast((e) => e.type === "message" && e.message.role === "assistant");
  if (last?.type !== "message" || typeof last.message.content === "string") return new Set();
  const results = outcomes(chain);
  return new Set(last.message.content.flatMap((b) => (b.type === "tool_use" && !results.has(b.id) ? [b.id] : [])));
}

/** Tool results by tool_use id: whether a `message` call was really sent. */
function sentIds(chain: Entry[]): Set<string> {
  const ok = chain.flatMap(toolResults).filter((b) => !b.is_error && resultText(b).startsWith("sent to"));
  return new Set(ok.map((b) => b.tool_use_id));
}

/** The inbox messages a user entry holds: its string content, or text blocks riding with tool results. */
function inboxMessages(content: MessageEntry["message"]["content"]) {
  const texts = typeof content === "string" ? [content] : content.flatMap((b) => (b.type === "text" ? [b.text] : []));
  return texts.flatMap(parseFormatted);
}

const fromUser = (m: { from: string }) => m.from === "user" || m.from === "";

/** A user entry: the user's lines first (they showed when typed), then each agent's message. Says whether the user spoke. */
function userEntry(content: MessageEntry["message"]["content"], inbox?: Message[]): { items: Item[]; user: boolean } {
  const msgs = inbox?.some(m => m.attachments?.length) ? inbox.map(m => ({ from: m.from, text: [m.text, imageLabels(m.attachments)].filter(Boolean).join("\n") })) : inboxMessages(content);
  const mine = msgs.filter(fromUser);
  const items = [...mine.flatMap((m) => { const lines = fromUserLines(m.text); return lines.length ? [now(lines)] : []; }), ...msgs.filter((m) => !fromUser(m)).map((m) => now([reportLine(m.from, m.text)]))];
  return { items, user: mine.length > 0 };
}

/** An assistant entry's lines: its text through a fresh stream (every entry ends flushed live), then its tool calls as they ended. */
function assistantLines(parts: Content, state: Pick<Fold, "results" | "omit">): Line[] {
  const md = new MarkdownStream();
  const said = parts.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const lines: Line[] = said ? [...md.feedLines(`${said}\n`), ...md.flushLines()] : [];
  for (const b of parts) {
    const line = b.type === "tool_use" ? callLine(b, state.results, state.omit) : null;
    if (line) lines.push(line);
  }
  return lines;
}

/** A sent `message` call to the user, as the reply it was (or null). */
function sentReply(b: Block, sent: Set<string>): Item | null {
  if (b.type !== "tool_use" || b.name !== "message" || !sent.has(b.id)) return null;
  const input = (b.input ?? {}) as { to?: unknown; text?: unknown };
  return String(input.to ?? "").trim() === "user" ? now([replyLine("orchestrator", String(input.text ?? "").trim())]) : null;
}

/** An assistant entry as an item (none when it holds only thinking), and its sent `message` calls to the user. */
function assistantEntry(content: MessageEntry["message"]["content"], sent: Set<string>, state: Pick<Fold, "results" | "omit">): { item: Item | null; replies: Item[] } {
  const parts: Content = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const shows = parts.some((b) => (b.type === "text" && b.text) || (b.type === "tool_use" && !state.omit?.has(b.id)));
  const replies = parts.map((b) => sentReply(b, sent)).filter((r): r is Item => r !== null);
  return { item: shows ? { lines: () => assistantLines(parts, state) } : null, replies };
}

/**
 * The current branch (transcript.ts `branch`: oldest first, a summary first)
 * as the page's messages, oldest first, none laid out yet. Turns record what
 * they sent the user in `replies` entries; before the first one (older
 * transcripts) the orchestrator's sent `message` calls to the user stand in,
 * held until the user next speaks. Calls in `omit` with no result yet are
 * left out (the turn is still running them) instead of showing interrupted.
 */
export function restoreItems(chain: Entry[], omit?: Set<string>): Item[] {
  const firstReplies = chain.findIndex((e) => e.type === "replies");
  const legacy = firstReplies === -1 ? chain.length : firstReplies;
  const sent = sentIds(chain.slice(0, legacy));
  const state: Fold = { items: [], held: [], results: outcomes(chain), omit };
  chain.forEach((e, i) => step(state, e, i < legacy ? sent : new Set()));
  return release(state).items;
}

/** The items so far, the stand-in replies waiting for the user to speak, every call's outcome, and the running calls to leave out. */
interface Fold { items: Item[]; held: Item[]; results: Map<string, ToolOutcome>; omit?: Set<string> }

function release(state: Fold): Fold {
  state.items.push(...state.held);
  state.held = [];
  return state;
}

/** One entry of the branch into the items. `sent` is empty past the first `replies` entry: from there they hold the replies. */
function step(state: Fold, e: Entry, sent: Set<string>): void {
  if (e.type === "summary") state.items.push({ lines: () => [SUMMARIZED], summary: true });
  // The run that recorded these also made the held message calls: the entry has them, so they are not shown twice.
  if (e.type === "replies") {
    state.held = [];
    state.items.push(...e.messages.map((m) => now([replyLine(m.from, m.text)])));
  }
  if (e.type !== "message") return;
  if (e.message.role === "user") {
    const { items, user } = userEntry(e.message.content, e.inbox);
    if (user) release(state);
    state.items.push(...items);
    return;
  }
  const { item, replies } = assistantEntry(e.message.content, sent, state);
  if (item) state.items.push(item);
  state.held.push(...replies);
}

/**
 * The page history for the current branch at `cols` columns: the newest
 * whole messages that fit in `maxRows` rendered rows (at least the newest
 * one), led by a dim count of the messages left out (settled questions' replies are not messages here). The budget includes neutral separators and the omission note, but not the
 * page header. The newest whole message is retained even when it alone exceeds it.
 */
export function restore(chain: Entry[], cols: number, maxRows = MAX_RESTORED_ROWS, omit?: Set<string>): Line[] {
  const items = restoreItems(chain, omit);
  if (maxRows === Infinity) return items.flatMap(item => item.lines());
  const shown: Line[][] = [];
  let from = items.length;
  while (from > 0) {
    const lines = items[from - 1]!.lines();
    const omitted = items.slice(0, from - 1).filter((it) => !it.summary).length;
    const combined = [...(from > 1 ? [earlier(omitted)] : []), ...lines, ...shown.flat()];
    const n = historyRows(combined, cols).reduce((n, row) => n + wrap(row, cols).length, 0);
    if (shown.length && n > maxRows) break;
    shown.unshift(lines);
    from--;
  }
  const dropped = items.slice(0, from).filter((it) => !it.summary).length;
  return [...(from > 0 ? [earlier(dropped)] : []), ...shown.flat()];
}
