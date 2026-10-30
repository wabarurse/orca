// How a tool call shows, like Claude Code: one line per call, its name and a
// short human summary of the input ("Bash(git status)"), and when it is done
// one line of result under it ("⎿  12 lines"). Pure and shared: the agent loop
// echoes calls with it, the TUI shows live calls with it, and restore.ts and
// view.ts rebuild them from transcripts with it, so all of them match.
// Everything it returns is plain text: every escape sequence and control in
// a command or a result is stripped here, at the source (`plain`), so neither a
// tmux pane nor the TUI's shimmer ever gets one.

import { plain, textLines } from "../providers";

/** A tool call as it starts. */
export interface ToolCall { id: string; name: string; input: unknown }
/** How it ended: `ok` is false for an is_error result; `text` is the result as the model got it. */
export interface ToolOutcome { id: string; ok: boolean; text: string }

/** A finished call as shown: its label, the one-line summary of its result, and whether it failed. */
export interface ToolView { tool: string; summary: string; failed: boolean }

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? plain(v) : "");
/** Text on one line: newlines and runs of spaces as single spaces. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** The first `n` words of `s`, with … when there were more. */
const words = (s: string, n: number) => {
  const all = oneLine(s).split(" ").filter(Boolean);
  return all.slice(0, n).join(" ") + (all.length > n ? "…" : "");
};
/** The first line of `s` with something on it. */
export const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim();

// Known app-owned labels only; unknown tool identifiers and all payloads stay verbatim.
const display = (name: string) => name === "web_search" ? "websearch" : name;

/** The first string value in an input, for tools without their own formatter. */
const firstString = (input: Input) => oneLine(str(Object.values(input).find((v) => typeof v === "string")));

function askArgs(input: Input): string {
  if (input.action === "list") return "list";
  if (input.action === "close") return `close ${Array.isArray(input.ids) ? input.ids.length : 0}: ${words(str(input.reason), 8)}`;
  const qs = Array.isArray(input.questions) ? (input.questions as { text?: unknown }[]) : [];
  const first = words(str(qs[0]?.text), 8);
  return qs.length > 1 ? `${qs.length} questions: ${first}` : first;
}

/** Per-tool input summaries; anything else shows its first string argument. */
const ARGS: Record<string, (input: Input) => string> = {
  bash: (i) => oneLine(str(i.command)),
  message: (i) => `${oneLine(str(i.to))}: ${words(str(i.text), 8)}`,
  spawn: (i) => `${oneLine(str(i.branch))}, ${i.role === "reviewer" ? "reviewer" : "worker"}`,
  ask: askArgs,
  web_search: (i) => oneLine(str(i.query)),
  history: (i) => oneLine(i.action === "read" ? `read ${str(i.project)}/${str(i.entryId)}` : `${str(i.action)} ${str(i.query)}`.trim()),
};

const asInput = (input: unknown): Input => (input && typeof input === "object" && !Array.isArray(input) ? (input as Input) : {});

/** "Bash(git status)": the tool's display name and a short summary of its input. */
export function toolLabel(name: string, input: unknown): string {
  const args = (ARGS[name] ?? firstString)(asInput(input));
  return oneLine(plain(`${display(name)}(${args})`));
}

const EXIT = /\n?\[exit (\d+)\]$/;
/** bash's timeout note, at the end (before its exit line, when there is one). */
const TIMEOUT = /\[timed out after ([^\];]+)(?:; saved output is incomplete)?\](?:\n\[exit \d+\])?$/;
/** The note bash.ts's truncateMiddle leaves where it cut the output. */
const TRUNCATED = /\n\.\.\.\[truncated \d+ bytes\]\.\.\.\n/;
const ERRORISH = /error|fail|fatal|denied|not found/i;
/** Lines that mention errors only to say there were none: "0 failed", "no errors", "0 errors", "0 fail". */
const NO_ERRORS = /\b(?:0|no|zero)\s+(?:errors?|failures?|failed|fail|fatal)\b|\b(?:errors?|failures?|failed|fail):?\s+0\b/i;

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Lines of output, a trailing newline not counting as one more. */
function lineCount(output: string): number {
  const t = output.replace(/\n$/, "");
  return t ? t.split("\n").length : 0;
}

/** ": <the last line that looks like an error (and is not "0 failed"), else the first with something on it>", or nothing. */
function errorLine(output: string): string {
  const lines = textLines(output).replace(TRUNCATED, "\n").split("\n").map((l) => oneLine(l)).filter(Boolean);
  const candidates = lines.filter((l) => !NO_ERRORS.test(l));
  const line = candidates.findLast((l) => ERRORISH.test(l)) ?? candidates[0];
  return line ? `: ${line}` : "";
}

/** "N lines", "no output", or "N+ lines (truncated)" when bash cut the middle out (its note not counted). */
function lines(output: string): string {
  const cut = TRUNCATED.exec(output);
  if (!cut) { const n = lineCount(output); return n ? plural(n, "line") : "no output"; }
  const n = lineCount(output.slice(0, cut.index)) + lineCount(output.slice(cut.index + cut[0].length));
  return `${n}+ lines (truncated)`;
}

/** bash's result: "N lines" (or "no output"), "exit N: <error line>", or the timeout. */
function bashSummary(text: string): { summary: string; failed: boolean } {
  text = text.replace(/\n\[(?:full|partial) output: [^\n]+\]$/, "");
  const timeout = TIMEOUT.exec(text);
  if (timeout) return { summary: `timed out after ${oneLine(timeout[1]!)}`, failed: true };
  const exit = EXIT.exec(text);
  if (exit) return { summary: `exit ${exit[1]}${errorLine(text.slice(0, exit.index))}`, failed: true };
  return { summary: lines(text), failed: false };
}

/** Per-tool result summaries for successful calls; anything else shows its result's first line. */
const SUMMARIES: Record<string, (text: string) => { summary: string; failed: boolean }> = {
  bash: bashSummary,
  spawn: (text) => ({ summary: `spawned ${oneLine(firstLine(text))}`, failed: false }),
};

/** Tools whose own refusals ("refused: …", not is_error results) count as failures; bash's output is the command's, so it never does. */
const REFUSING = new Set(["spawn", "message", "ask", "history"]);
const refused = (name: string, text: string) => REFUSING.has(name) && /^refused\b/.test(text.trim());

/** The one-line summary of how a call ended, and whether it failed. */
export function toolSummary(name: string, outcome: Pick<ToolOutcome, "ok" | "text">): { summary: string; failed: boolean } {
  const ok = outcome.ok;
  const text = textLines(outcome.text);
  if (!ok || refused(name, text)) return { summary: oneLine(firstLine(text)) || "error", failed: true };
  return SUMMARIES[name]?.(text) ?? { summary: oneLine(firstLine(text)) || "done", failed: false };
}

/** What a call shows when it never ended (the turn stopped, the agent died, or the transcript stops mid-call). */
export const INTERRUPTED = "interrupted";

/** A call that never ended, as shown: failed, "interrupted". */
export const interruptedView = (name: string, input: unknown): ToolView => ({ tool: toolLabel(name, input), summary: INTERRUPTED, failed: true });

/** A finished call as shown. */
export function toolView(name: string, input: unknown, outcome: Pick<ToolOutcome, "ok" | "text">): ToolView {
  return { tool: toolLabel(name, input), ...toolSummary(name, outcome) };
}

/** The marker leading a call's line. */
export const TOOL_MARK = "⏺";
/** What leads the result line under it. */
export const RESULT_MARK = "  ⎿  ";

/** Plain text cut to about `max` columns with … (by code point; for stdout, where no width is known). */
export function capped(s: string, max = 200): string {
  const text = oneLine(plain(s));
  if (Bun.stringWidth(text) <= max) return text;
  let out = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    if (Bun.stringWidth(out + segment) > max - 1) break;
    out += segment;
  }
  return `${out}…`;
}

/** A call's "⏺" line as plain text, capped, for a terminal without the TUI (a worker's tmux pane). */
export const callText = (call: Pick<ToolCall, "name" | "input">): string => `${TOOL_MARK} ${capped(toolLabel(call.name, call.input))}`;
/** Its "⎿" summary line as plain text, capped. */
export const resultText = (name: string, outcome: Pick<ToolOutcome, "ok" | "text">): string => `${RESULT_MARK}${capped(toolSummary(name, outcome).summary)}`;
