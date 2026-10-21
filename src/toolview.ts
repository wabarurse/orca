// How a tool call shows, like Claude Code: one line per call, its name and a
// short human summary of the input ("Bash(git status)"), and when it is done
// one line of result under it ("⎿  12 lines"). Pure and shared: the agent loop
// echoes calls with it, the TUI shows live calls with it, and restore.ts and
// view.ts rebuild them from transcripts with it, so all of them match.

/** A tool call as it starts. */
export interface ToolCall { id: string; name: string; input: unknown }
/** How it ended: `ok` is false for an is_error result; `text` is the result as the model got it. */
export interface ToolOutcome { id: string; ok: boolean; text: string }

/** A finished call as shown: its label, the one-line summary of its result, and whether it failed. */
export interface ToolView { tool: string; summary: string; failed: boolean }

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** Text on one line: newlines and runs of spaces as single spaces. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** The first `n` words of `s`, with … when there were more. */
const words = (s: string, n: number) => {
  const all = oneLine(s).split(" ").filter(Boolean);
  return all.slice(0, n).join(" ") + (all.length > n ? "…" : "");
};
/** The first line of `s` with something on it. */
export const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim();

const display = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The first string value in an input, for tools without their own formatter. */
const firstString = (input: Input) => oneLine(Object.values(input).find((v) => typeof v === "string") ?? "");

function askArgs(input: Input): string {
  const qs = Array.isArray(input.questions) ? (input.questions as { text?: unknown }[]) : [];
  const first = words(str(qs[0]?.text), 8);
  return qs.length > 1 ? `${qs.length} questions: ${first}` : first;
}

function complexityArgs(input: Input): string {
  const files = Array.isArray(input.files) ? input.files.map(String) : [];
  return files.length ? files.join(", ") : `changed files${input.base ? ` vs ${str(input.base)}` : ""}`;
}

/** Per-tool input summaries; anything else shows its first string argument. */
const ARGS: Record<string, (input: Input) => string> = {
  bash: (i) => oneLine(str(i.command)),
  message: (i) => `${oneLine(str(i.to))}: ${words(str(i.text), 8)}`,
  spawn: (i) => `${oneLine(str(i.branch))}, ${i.role === "reviewer" ? "reviewer" : "worker"}`,
  complexity: complexityArgs,
  ask: askArgs,
};

const asInput = (input: unknown): Input => (input && typeof input === "object" && !Array.isArray(input) ? (input as Input) : {});

/** "Bash(git status)": the tool's display name and a short summary of its input. */
export function toolLabel(name: string, input: unknown): string {
  const args = (ARGS[name] ?? firstString)(asInput(input));
  return `${display(name)}(${args})`;
}

const EXIT = /\n?\[exit (\d+)\]$/;
const TIMEOUT = /\[timed out after ([^\]]+)\]/;
const ERRORISH = /error|fail|fatal|denied|not found/i;

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Lines of output, a trailing newline not counting as one more. */
function lineCount(output: string): number {
  const t = output.replace(/\n$/, "");
  return t ? t.split("\n").length : 0;
}

/** ": <the first line that looks like an error, else the first with something on it>", or nothing. */
function errorLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => ERRORISH.test(l)) ?? lines[0];
  return line ? `: ${line}` : "";
}

/** bash's result: "N lines" (or "no output"), "exit N: <first error line>", or the timeout. */
function bashSummary(text: string): { summary: string; failed: boolean } {
  const timeout = TIMEOUT.exec(text);
  if (timeout) return { summary: `timed out after ${timeout[1]}`, failed: true };
  const exit = EXIT.exec(text);
  if (exit) return { summary: `exit ${exit[1]}${errorLine(text.slice(0, exit.index))}`, failed: true };
  const n = lineCount(text);
  return { summary: n ? plural(n, "line") : "no output", failed: false };
}

/** Per-tool result summaries for successful calls; anything else shows its result's first line. */
const SUMMARIES: Record<string, (text: string) => { summary: string; failed: boolean }> = {
  bash: bashSummary,
  spawn: (text) => ({ summary: `spawned ${firstLine(text)}`, failed: false }),
};

/** A tool's own refusal ("refused: …") is a failure too, though not an is_error result. */
const refused = (text: string) => /^refused\b/.test(text.trim());

/** The one-line summary of how a call ended, and whether it failed. */
export function toolSummary(name: string, outcome: Pick<ToolOutcome, "ok" | "text">): { summary: string; failed: boolean } {
  const { ok, text } = outcome;
  if (!ok || refused(text)) return { summary: firstLine(text) || "error", failed: true };
  return SUMMARIES[name]?.(text) ?? { summary: firstLine(text) || "done", failed: false };
}

/** A finished call as shown. */
export function toolView(name: string, input: unknown, outcome: Pick<ToolOutcome, "ok" | "text">): ToolView {
  return { tool: toolLabel(name, input), ...toolSummary(name, outcome) };
}

/** The marker leading a call's line. */
export const TOOL_MARK = "⏺";
/** What leads the result line under it. */
export const RESULT_MARK = "  ⎿  ";
