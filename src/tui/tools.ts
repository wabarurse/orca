// Tool calls on screen, like Claude Code: while a call runs its line sits in
// the live region with the shimmer ("⏺ Bash(git status)"); when it ends, that
// line and one summary line under it ("  ⎿  12 lines") go into the history as
// a { tool } Line, laid out at the current width (cut, never wrapped). The
// marker is dim, red when the call failed (bold under NO_COLOR). The labels
// and summaries come from src/toolview.ts, shared with restore.ts and the
// agent loop, so live and restored pages match. On screen, a run of two or
// more finished calls with nothing else between them folds into one dim line
// ("▸ 7 tool calls · bash ×4, read ×2, edit ×1 · 1 failed", `collapseCalls`
// and `groupRow`) until a click opens it (▾, its calls indented under it); the
// history keeps the calls themselves, so both views come from the same lines.

import { RESULT_MARK, TOOL_MARK, toolView, interruptedView, type ToolCall, type ToolOutcome, type ToolView } from "../toolview";
import type { Part } from "../view";
import type { Line, Shown } from "./lines";
import { dim, fit, sanitize, visibleLength } from "./render";
import { shimmer } from "./shimmer";
import { noColour } from "./style";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** The marker before a call: dim, or red when it failed (bold without colour). */
function mark(failed: boolean, glyph = TOOL_MARK): string {
  if (!failed) return dim(glyph);
  return noColour() ? bold(glyph) : `\x1b[31m${glyph}\x1b[0m`;
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
function tally(calls: ToolView[]): string {
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

const isCall = (l: Line): l is ToolView => typeof l !== "string" && "tool" in l;

/** `lines` with every run of two or more finished calls folded into one `{ calls }` line (`open` when its start index is in `open`: a click opened it); a lone call stays as it is. */
export function collapseCalls(lines: readonly Line[], open?: ReadonlySet<number>): Shown[] {
  const out: Shown[] = [];
  let run: ToolView[] = [], start = 0;
  const fold = () => { if (run.length) out.push(run.length === 1 ? run[0]! : open?.has(start) ? { calls: run, open: true } : { calls: run }); run = []; };
  for (const [i, l] of lines.entries()) {
    if (isCall(l)) { if (!run.length) start = i; run.push(l); }
    else { fold(); out.push(l); }
  }
  fold();
  return out;
}

/** Where each run of two or more finished calls starts in `lines`, in order: the identity of a folded group across re-renders of the same history. */
export function groupStarts(lines: readonly Line[]): number[] {
  const call = (i: number) => i >= 0 && i < lines.length && isCall(lines[i]!);
  return lines.flatMap((_, i) => call(i) && !call(i - 1) && call(i + 1) ? [i] : []);
}

/** The group opened by a click, as its start index in `lines`, from its position among the shown lines. */
export function groupStart(lines: readonly Line[], shown: readonly Shown[], at: number): number | undefined {
  const line = shown[at];
  if (!line || typeof line === "string" || !("calls" in line)) return;
  const ordinal = shown.slice(0, at).filter((l) => typeof l !== "string" && "calls" in l).length;
  return groupStarts(lines)[ordinal];
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
    const lines = [...this.running.values()].map((c) => interruptedView(c.name, c.input));
    this.running.clear();
    return lines;
  }

  /** The call ended: its history line (a call not seen starting shows as "Tool"). */
  finish(outcome: ToolOutcome): Line {
    const call = this.running.get(outcome.id);
    this.running.delete(outcome.id);
    return toolView(call?.name ?? "tool", call?.input ?? {}, outcome);
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
