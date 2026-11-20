// Tool calls on screen, like Claude Code: while a call runs its line sits in
// the live region with the shimmer ("⏺ Bash(git status)"); when it ends, that
// line and one summary line under it ("  ⎿  12 lines") go into the history as
// a { tool } Line, laid out at the current width (cut, never wrapped). The
// marker is dim, red when the call failed (bold under NO_COLOR). The labels
// and summaries come from src/protocol/toolview.ts, shared with restore.ts and the
// agent loop, so live and restored pages match. On screen, a run of two or
// more finished calls with nothing else between them folds into one dim line
// ("▸ 7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed", `collapseCalls`
// and `groupRow`) until a click opens it (▾, its calls indented under it); the
// history keeps the calls themselves, so both views come from the same lines.

import { RESULT_MARK, TOOL_MARK, callItems, toolView, interruptedView, type ToolCall, type ToolOutcome, type ToolView } from "../../protocol";
import type { Part } from "./view";
import type { CallLine, GroupKind, Line, Shown } from "./lines";
import { wrap } from "../components";
import { dim, fit, sanitize, visibleLength } from "../components";
import { shimmer } from "../components";
import { noColour, pastel } from "../components";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** The marker before a call: dim, or red when it failed (bold without colour). */
function mark(failed: boolean, glyph = TOOL_MARK): string {
  if (!failed) return dim(glyph);
  return noColour() ? bold(glyph) : `\x1b[${pastel.red}m${glyph}\x1b[0m`;
}

/** "Bash(git status)" with the tool's name in bold. */
function label(text: string): string {
  const open = text.indexOf("(");
  return open > 0 ? `${bold(text.slice(0, open))}${text.slice(open)}` : text;
}

/** A finished call as screen rows at `cols`, each cut to fit: the call, then its summary. */
export function toolRows(v: ToolView, cols: number): string[] {
  const head = fit(`${mark(v.failed)} ${label(sanitize(v.tool))}`, cols);
  const tail = dim(fit(`${RESULT_MARK}${sanitize(v.summary)}`, cols));
  return [head, tail];
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** "bash ×4, read ×2, edit ×1": each tool's calls, most first, ties in the order they were first called. */
export function tally(calls: ToolView[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) { const name = c.tool.split("(")[0]!; counts.set(name, (counts.get(name) ?? 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ×${n}`).join(", ");
}

/** The marker of a run's summary row: it can be clicked open (▸) or folded again (▾). */
const CLOSED = "▸", OPEN = "▾";

/**
 * A run of finished calls as one dim row: "▸ 7 tool calls · bash ×4, read ×2,
 * edit ×1 · 1 failed" (no "· N failed" when none failed; the marker red when
 * one did; ▾ once a click opened it). When the width is short the tally is
 * cut first, then dropped, so the count and the failures stay.
 */
export function groupRow(calls: ToolView[], cols: number, open = false): string {
  const failed = calls.filter((c) => c.failed).length;
  const glyph = open ? OPEN : CLOSED;
  const head = plural(calls.length, "tool call");
  const tail = failed ? ` · ${failed} failed` : "";
  const room = cols - visibleLength(`${glyph} ${head}${tail}`);
  const names = sanitize(` · ${tally(calls)}`);
  const list = visibleLength(names) <= room ? names : room >= 6 ? fit(names, room) : "";
  return fit(`${mark(failed > 0, glyph)} ${dim(`${head}${list}${tail}`)}`, cols);
}

const isCall = (l: Line): l is CallLine => typeof l !== "string" && "tool" in l;
const isImage = (l: Line): l is { image: string } => typeof l !== "string" && "image" in l;

/** The order a run's folds show in, after its tool calls. */
const GROUPS: { group: GroupKind; kind: CallLine["kind"] | "image" }[] = [
  { group: "questions", kind: "question" }, { group: "images", kind: "image" }, { group: "agents", kind: "agent" }, { group: "tasks", kind: "task" },
];

/**
 * `lines` as shown. A run of finished calls and delivered images (nothing else between them) becomes: its ordinary calls
 * (one stays as it is, two or more fold into one `calls` line), then one `group` fold per kind of item, in GROUPS order:
 * the questions its ask calls asked, its images, the agents its spawn calls started, the tasks it recorded. An agent's
 * message is a `from` fold. Every fold has a `key` (its kind and the index of the line it starts at) and is `open` when
 * that key is in `open`.
 */
export function collapseCalls(lines: readonly Line[], open: ReadonlySet<string> = new Set()): Shown[] {
  const out: Shown[] = [];
  let run: Line[] = [], start = 0;
  const fold = () => {
    if (!run.length) return;
    const calls = run.filter(isCall), tools = calls.filter(c => c.kind === "tool");
    const key = `calls:${start}`;
    if (tools.length === 1) out.push(tools[0]!);
    else if (tools.length > 1) out.push({ calls: tools, open: open.has(key), key });
    for (const { group, kind } of GROUPS) {
      const items = kind === "image" ? run.filter(isImage).map(l => l.image) : calls.filter(c => c.kind === kind).flatMap(c => c.items);
      const groupKey = `${group}:${start}`;
      if (items.length) out.push({ group, items, open: open.has(groupKey), key: groupKey });
    }
    run = [];
  };
  for (const [i, l] of lines.entries()) {
    if (isCall(l) || isImage(l)) { if (!run.length) start = i; run.push(l); continue; }
    fold();
    if (typeof l !== "string" && "from" in l) { const key = `from:${i}`; out.push({ ...l, open: open.has(key), key }); }
    else out.push(l);
  }
  fold();
  return out;
}

/** The keys of every fold in `shown`, in order: how open folds are carried to a new rendering of the same history (by kind and position). */
export function foldKeys(shown: readonly Shown[]): string[] {
  return shown.flatMap(l => typeof l !== "string" && "key" in l ? [l.key] : []);
}

/** A fold's title: "+ 2 questions", "from worker-a". */
export function foldTitle(l: Extract<Shown, { key: string }>): string {
  if ("calls" in l) return plural(l.calls.length, "tool call");
  if ("group" in l) return `+ ${l.items.length} ${l.items.length === 1 ? l.group.replace(/s$/, "") : l.group}`;
  return `from ${l.from}`;
}

/** A message's text as rows at `cols`: each of its lines sanitized and wrapped on its own, so its line breaks stay. */
export const messageRows = (text: string, cols: number): string[] => text.split("\n").flatMap(line => wrap(sanitize(line), cols));

/** A fold (or a lone image, or an agent's message line) as plain rows, for the transcript printed on exit: its title, then what it holds. */
export function foldRows(l: Exclude<Shown, string | { md: string } | { user: string } | CallLine | { calls: CallLine[] }>, cols: number): string[] {
  if ("image" in l) return [dim(fit(sanitize(l.image), cols))];
  const open = "open" in l && l.open;
  const title = dim(fit(`${open ? OPEN : CLOSED} ${sanitize(foldTitle("key" in l ? l : { ...l, open: false, key: "" }))}`, cols));
  if (!open) return [title];
  if ("group" in l) return [title, ...l.items.map(item => fit(`  ${dim("●")} ${sanitize(item)}`, cols))];
  return [title, ...messageRows(l.text, Math.max(1, cols - 5)).map((row, i) => `  ${dim(i ? " " : "⎿")}  ${row}`)];
}

/** A running call's row at `now`: the dim marker and its label with the shimmer. */
export function runningRow(call: Pick<ToolCall, "name" | "input">, now: number, cols: number): string {
  const text = fit(sanitize(toolView(call.name, call.input, { ok: true, text: "" }).tool), Math.max(1, cols - 2));
  return fit(`${dim(TOOL_MARK)} ${shimmer(Bun.stripANSI(text), now)}`, cols);
}

/** The calls running on a page or in an agent view, oldest first. */
export class Calls {
  private readonly running = new Map<string, ToolCall>();

  get size(): number { return this.running.size; }

  start(call: ToolCall): void { this.running.set(call.id, call); }

  /** Forget the running calls without a line: the durable record now shows them. */
  clear(): void { this.running.clear(); }

  interrupt(): Line[] {
    const lines = [...this.running.values()].map((c): Line => ({ ...interruptedView(c.name, c.input), kind: "tool", items: [] }));
    this.running.clear();
    return lines;
  }

  /** The call ended: its history line (a call not seen starting shows as "Tool"). */
  finish(outcome: ToolOutcome): Line {
    const call = this.running.get(outcome.id);
    this.running.delete(outcome.id);
    return { ...toolView(call?.name ?? "tool", call?.input ?? {}, outcome), ...callItems(call?.name ?? "tool", call?.input ?? {}, outcome) };
  }

  /** The running calls' rows at `now`. */
  rows(now: number, cols: number): string[] {
    return [...this.running.values()].map((c) => runningRow(c, now, cols));
  }

  /** A followed transcript's parts as history lines: calls start running, their results finish them. */
  absorb(parts: Part[]): Line[] {
    const out: Line[] = [];
    for (const p of parts) {
      if (typeof p !== "string" && "call" in p) this.start(p.call);
      else if (typeof p !== "string" && "result" in p) out.push(this.finish(p.result));
      else out.push(p);
    }
    return out;
  }
}
