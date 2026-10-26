import { imageLabels } from "../../core/data/images/images";
import type { Message } from "../../core/data/inbox/inbox";
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
// - An explicit answer (or a legacy delivered skip) showed live as its dim
//   "? <question> → <answer>" line when it was answered; restored, the same
//   line sits where the orchestrator read the answer from its inbox (answers
//   from another TUI show there live too). Questions still open are not in the
//   transcript: the queue shows them again from questions/. A reply is read
//   by its question's id against questions/ (answered and skipped files are
//   kept), so quotes or `": ` in the question cannot confuse it; only a
//   missing file falls back to parsing the message text. New silent skips only
//   update questions/; their local dismissal notes are not transcript entries.
// - Errors, command output (/help, /agents, …), page notices ("queued; runs
//   after sign-in") and anything else the app itself said are not in the
//   transcript and are not restored. Informational status notes ("model set
//   to …", a rename, "orchestrator was not running; restarted") are not even page lines: App
//   shows them as one transient row above the composer (`App.note`).

import { parseFormatted } from "../../core/data/inbox/inbox";
import type { Entry, MessageEntry } from "../../core/data/transcripts/transcript";
import { interruptedView, toolView, type ToolOutcome } from "../../core/agent-loop/loop/toolview";
import { historyRows, type Line } from "./lines";
import { MarkdownStream } from "./mdstream";
import { plainText, bold, dim, wrap } from "../components/render";

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

/** An explicit answer or historical delivered skip. The default tail is legacy
 * transcript compatibility only; new silent dismissals never use this path. */
export function answeredLine(question: string, answer: string | null, def?: string): string {
  const tail = answer ?? (def ? `skipped, default: ${def}` : "skipped");
  return dim(`? ${plainText(question)} → ${plainText(tail)}`);
}

/** A question id as questions.ts makes them: its ask time, a sequence number and a random suffix. */
const QUESTION_ID = String.raw`\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-\d{6}-[0-9a-f]{8}`;
/** The start of a delivered answer or legacy skip message. */
const REPLY_HEAD = new RegExp(`^\\[(${QUESTION_ID})\\] (answer to|skipped) "`);
/** Fallbacks for a question whose file is gone: the text is cut at the last `": ` (answers) or matched against the skip's tail. */
const ANSWERED = new RegExp(`^\\[${QUESTION_ID}\\] answer to "([^\\n]*?)": ([^\\n]*)$`);
const SKIPPED = new RegExp(`^\\[${QUESTION_ID}\\] skipped "([^\\n]*)"(?:; use your default \\(([^\\n]*)\\)| \\(no default given\\); decide yourself)$`);

/** What a reply needs of its question (questions.ts `Question`): its text, default and, once answered, the answer. */
export interface AskedQuestion { text: string; default?: string; status?: string; answer?: string }
/** Questions by id, answered and skipped ones included (questions/ keeps them). */
export type AskedLookup = (id: string) => AskedQuestion | undefined;

/** The line for a reply whose question is known: the question's own text, so quotes or `": ` in it cannot confuse the parse. */
function knownReply(text: string, id: string, kind: string, q: AskedQuestion): string | null {
  if (kind === "skipped") return answeredLine(q.text, null, q.default);
  if (q.status === "answered" && q.answer !== undefined) return answeredLine(q.text, q.answer);
  const prefix = `[${id}] answer to "${q.text}": `;
  return text.startsWith(prefix) ? answeredLine(q.text, text.slice(prefix.length)) : null;
}

/**
 * A "user" message that is a question's answer or skip (questions.ts): its id
 * and its line, else null. The question is looked up by id (`asked`); only
 * when it is unknown is the text parsed alone.
 */
export function questionReply(text: string, asked?: AskedLookup): { id: string; line: string } | null {
  const head = REPLY_HEAD.exec(text);
  if (!head) return null;
  const id = head[1]!;
  const q = asked?.(id);
  const known = q ? knownReply(text, id, head[2]!, q) : null;
  if (known) return { id, line: known };
  const a = ANSWERED.exec(text);
  if (a) return { id, line: answeredLine(a[1]!, a[2]!) };
  const s = SKIPPED.exec(text);
  return s ? { id, line: answeredLine(s[1]!, null, s[2]) } : null;
}

/** A message from the user as the page shows it: a question's answer as its dim line, anything else as "> …". */
export const fromUserLines = (text: string, asked?: AskedLookup): Line[] => {
  const reply = questionReply(text, asked);
  return reply ? [reply.line] : userLines(text);
};

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
function userEntry(content: MessageEntry["message"]["content"], asked?: AskedLookup, inbox?: Message[]): { items: Item[]; user: boolean } {
  const msgs = inbox?.some(m => m.attachments?.length) ? inbox.map(m => ({ from: m.from, text: [m.text, imageLabels(m.attachments)].filter(Boolean).join("\n") })) : inboxMessages(content);
  const mine = msgs.filter(fromUser);
  const items = [...mine.map((m) => now(fromUserLines(m.text, asked))), ...msgs.filter((m) => !fromUser(m)).map((m) => now([reportLine(m.from, m.text)]))];
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
export function restoreItems(chain: Entry[], asked?: AskedLookup, omit?: Set<string>): Item[] {
  const firstReplies = chain.findIndex((e) => e.type === "replies");
  const legacy = firstReplies === -1 ? chain.length : firstReplies;
  const sent = sentIds(chain.slice(0, legacy));
  const state: Fold = { items: [], held: [], results: outcomes(chain), omit };
  chain.forEach((e, i) => step(state, e, i < legacy ? sent : new Set(), asked));
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
function step(state: Fold, e: Entry, sent: Set<string>, asked?: AskedLookup): void {
  if (e.type === "summary") state.items.push({ lines: () => [SUMMARIZED], summary: true });
  // The run that recorded these also made the held message calls: the entry has them, so they are not shown twice.
  if (e.type === "replies") {
    state.held = [];
    state.items.push(...e.messages.map((m) => now([replyLine(m.from, m.text)])));
  }
  if (e.type !== "message") return;
  if (e.message.role === "user") {
    const { items, user } = userEntry(e.message.content, asked, e.inbox);
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
 * one), led by a dim count of the messages left out. The budget includes neutral separators and the omission note, but not the
 * page header. The newest whole message is retained even when it alone exceeds it.
 */
export function restore(chain: Entry[], cols: number, maxRows = MAX_RESTORED_ROWS, asked?: AskedLookup, omit?: Set<string>): Line[] {
  const items = restoreItems(chain, asked, omit);
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
