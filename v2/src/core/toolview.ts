import { plain, textLines } from "../api";
import type { ToolCall, ToolOutcome } from "./types";
import { asRecord } from "../config";

export type ToolView = { tool: string; summary: string; failed: boolean };

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? plain(v) : "");
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const words = (s: string, n: number) => {
  const all = oneLine(s).split(" ").filter(word => word !== "");
  return all.slice(0, n).join(" ") + (all.length > n ? "…" : "");
};
export const firstLine = (s: string) => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim();
const or = (text: string, fallback: string) => text !== "" ? text : fallback;

const display = (name: string) => name === "web_search" ? "websearch" : name;

const firstString = (input: Input) => oneLine(str(Object.values(input).find((v) => typeof v === "string")));

const ARGS: Record<string, (input: Input) => string> = {
  bash: (i) => oneLine(str(i.command)),
  inbox: (i) => `${oneLine(str(i.to))}: ${words(str(i.text), 8)}`,
  subagent: (i) => i.action === "spawn" ? `${oneLine(str(i.branch))}, ${or(oneLine(str(i.bundle)), "worker")}` : oneLine(`${str(i.action)} ${str(i.agent)}`),
  web_search: (i) => oneLine(str(i.query)),
  memory: (i) => oneLine(`${str(i.action)} ${Array.isArray(i.queries) ? i.queries.map(str).join(" | ") : Array.isArray(i.ids) ? i.ids.map(str).join(", ") : or(str(i.node), str(i.branch))}`),
};

const pluginLabels = new Map<string, (input: Input) => string>();
const pluginSummaries = new Map<string, (outcome: { ok: boolean; text: string }) => { summary: string; failed: boolean }>();
export function registerToolLine(name: string, label: (input: Input) => string, summary: (outcome: { ok: boolean; text: string }) => { summary: string; failed: boolean }): void {
  pluginLabels.set(name, label);
  pluginSummaries.set(name, summary);
}

const asInput = (input: unknown): Input => asRecord(input) ?? {};

export const toolArgs = (name: string, input: unknown): string => oneLine(plain((pluginLabels.get(name) ?? ARGS[name] ?? firstString)(asInput(input))));

export function toolLabel(name: string, input: unknown): string {
  return oneLine(plain(`${display(name)}(${toolArgs(name, input)})`));
}

const EXIT = /\n?\[exit (\d+)\]$/;
const TIMEOUT = /\[timed out after ([^\];]+)(?:; saved output is incomplete)?\](?:\n\[exit \d+\])?$/;
const TRUNCATED = /\n\.\.\.\[truncated \d+ bytes\]\.\.\.\n/;
const ERRORISH = /error|fail|fatal|denied|not found/i;
const NO_ERRORS = /\b(?:0|no|zero)\s+(?:errors?|failures?|failed|fail|fatal)\b|\b(?:errors?|failures?|failed|fail):?\s+0\b/i;

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

function lineCount(output: string): number {
  const t = output.replace(/\n$/, "");
  return t !== "" ? t.split("\n").length : 0;
}

function errorLine(output: string): string {
  const lines = textLines(output).replace(TRUNCATED, "\n").split("\n").map((l) => oneLine(l)).filter((l) => l !== "");
  const candidates = lines.filter((l) => !NO_ERRORS.test(l));
  const line = candidates.findLast((l) => ERRORISH.test(l)) ?? candidates[0];
  return line !== undefined && line !== "" ? `: ${line}` : "";
}

function lines(output: string): string {
  const cut = TRUNCATED.exec(output);
  if (cut === null) { const n = lineCount(output); return n > 0 ? plural(n, "line") : "no output"; }
  const n = lineCount(output.slice(0, cut.index)) + lineCount(output.slice(cut.index + cut[0].length));
  return `${n}+ lines (truncated)`;
}

function bashSummary(text: string): { summary: string; failed: boolean } {
  text = text.replace(/\n\[(?:full|partial) output: [^\n]+\]$/, "");
  const timeout = TIMEOUT.exec(text);
  if (timeout !== null) return { summary: `timed out after ${oneLine(timeout[1] ?? "")}`, failed: true };
  const exit = EXIT.exec(text);
  if (exit !== null) return { summary: `exit ${exit[1]}${errorLine(text.slice(0, exit.index))}`, failed: true };
  return { summary: lines(text), failed: false };
}

const SUMMARIES: Record<string, (text: string) => { summary: string; failed: boolean }> = {
  bash: bashSummary,
};

const REFUSING = new Set(["subagent", "inbox", "memory", "behavior"]);
const refused = (name: string, text: string) => REFUSING.has(name) && /^refused\b/.test(text.trim());

export function toolSummary(name: string, outcome: Pick<ToolOutcome, "ok" | "text">): { summary: string; failed: boolean } {
  const own = pluginSummaries.get(name);
  if (own !== undefined) return own(outcome);
  const ok = outcome.ok;
  const text = textLines(outcome.text);
  if (!ok || refused(name, text)) return { summary: or(oneLine(firstLine(text)), "error"), failed: true };
  return SUMMARIES[name]?.(text) ?? { summary: or(oneLine(firstLine(text)), "done"), failed: false };
}

export const INTERRUPTED = "interrupted";

export const interruptedView = (name: string, input: unknown): ToolView => ({ tool: toolLabel(name, input), summary: INTERRUPTED, failed: true });

export function toolView(name: string, input: unknown, outcome: Pick<ToolOutcome, "ok" | "text">): ToolView {
  return { tool: toolLabel(name, input), ...toolSummary(name, outcome) };
}

export const TOOL_MARK = "⏺";
export const RESULT_MARK = "  ⎿  ";

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

export const callText = (call: Pick<ToolCall, "name" | "input">): string => `${TOOL_MARK} ${capped(toolLabel(call.name, call.input))}`;
export const resultText = (name: string, outcome: Pick<ToolOutcome, "ok" | "text">): string => `${RESULT_MARK}${capped(toolSummary(name, outcome).summary)}`;
