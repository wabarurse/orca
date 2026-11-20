// What a page's history holds, and how one entry is laid out on screen.

import { renderBlock, renderLabelled, renderMarkdown } from "./markdown";
import { sanitize, wrap } from "../components";
import { fillRow, userFill } from "../components";
import { foldRows, groupRow, toolRows } from "./tools";
import type { CallKind, ToolView } from "../../protocol";

/** A user message line ("> …" or its indented continuation) at `cols`: wrapped, every row on the user background, full width. */
export function userRows(line: string, cols: number): string[] {
  const rows = wrap(sanitize(line), cols);
  const fill = userFill();
  return fill ? rows.map((r) => fillRow(r, cols, fill)) : rows;
}

/**
 * A line of history. Plain text stays as it is; the orchestrator's markdown is
 * kept as written (`md`: one parser block with explicit `continuation`, or a whole text led by `label`)
 * and laid out at the current width whenever it is drawn, so a reprint after a
 * resize fits tables to the new width. A line of the user's own message
 * (`user`, "> …" or its indented continuation) is drawn on the user
 * background, full width (`userRows`). A finished tool call
 * (`tool`, its `summary`, `failed`) shows as its "⏺" line and "⎿" summary,
 * cut to the width (tools.ts `toolRows`).
 */
export type Line = string | { md: string; block?: boolean; label?: string; continuation?: true } | { user: string } | CallLine | FromLine | ImageLine;

/** A finished call: how it shows (ToolView) and what it stands for (protocol `callItems`: the questions it asked, the agent it started, the task it recorded). */
export type CallLine = ToolView & { kind: CallKind; items: string[] };
/** A message from an agent to the orchestrator (a worker's report, a reviewer's verdict, a runtime notice). */
export type FromLine = { from: string; text: string };
/** An image delivered to the user: its one-line label. */
export type ImageLine = { image: string };

/** What a run of calls and images adds besides the calls themselves, one fold each. */
export type GroupKind = "questions" | "images" | "agents" | "tasks";

/**
 * A line as shown (tools.ts `collapseCalls`): a history line, or a fold the history never holds. A run of finished calls
 * (with the images delivered beside them) folds into a `calls` line (two or more ordinary calls) and one `group` per kind
 * of item (questions asked, images, agents started, tasks recorded); an agent's message is a `from` fold. `key` names a fold
 * across re-renders of the same history; `open` is whether a click opened it.
 */
export type Shown = Line | { calls: CallLine[]; open: boolean; key: string } | { group: GroupKind; items: string[]; open: boolean; key: string } | (FromLine & { open: boolean; key: string });

/** A history line as screen lines at `cols` columns. */
// A line's rows depend only on its content and the width, and almost every line of a history is the
// same from one rendering to the next (a transcript re-sync builds new line objects for the same
// content). Laying them out again is the cost of a redraw on a long conversation, so the rows are
// kept by content: one map per width and kind, keyed by the line's own text (no copy of it).
const laidOut = new Map<string, Map<string, string[]>>();
let laidOutCount = 0;
/** Every kept line; past it the whole cache is dropped and refilled by the next rendering. */
const LAID_OUT_MAX = 250_000;

/** The rows `make` returns, kept under `kind` (which names the width) and `key`. Callers treat them as read-only. */
function kept(kind: string, key: string, make: () => string[]): string[] {
  let rows = laidOut.get(kind)?.get(key);
  if (rows) return rows;
  if (laidOutCount >= LAID_OUT_MAX) { laidOut.clear(); laidOutCount = 0; }
  let byKey = laidOut.get(kind);
  if (!byKey) laidOut.set(kind, byKey = new Map());
  byKey.set(key, rows = make()); laidOutCount++;
  return rows;
}

const toolLine = (v: { tool: string; summary: string; failed: boolean }, cols: number) =>
  kept(`${cols} tool`, `${v.failed ? 1 : 0}${v.tool}\0${v.summary}`, () => toolRows(v, cols));

/** One history line at `cols` columns. The rows are shared with later calls: never change them. */
export function lineRows(l: Shown, cols: number): string[] {
  if (typeof l === "string") return [l];
  if ("user" in l) return userRows(l.user, cols);
  if ("tool" in l) return toolLine(l, cols);
  if ("calls" in l) return [groupRow(l.calls, cols, l.open), ...(l.open ? l.calls.flatMap((c) => toolLine(c, Math.max(1, cols - 2)).map((r) => `  ${r}`)) : [])];
  if ("group" in l || "from" in l || "image" in l) return foldRows(l, cols);
  if (l.block) return kept(`${cols} block`, l.md, () => renderBlock(l.md, cols));
  const label = l.label;
  return label ? kept(`${cols} label ${label}`, l.md, () => renderLabelled(label, l.md, cols)) : kept(`${cols} md`, l.md, () => renderMarkdown(l.md, cols));
}

/** A logical boundary, not a wrapped row or a chunk of a still-streaming paragraph. */
function startsBlock(line: Shown): boolean {
  if (typeof line === "string") return false;
  if ("user" in line) return line.user.startsWith("\x1b[1m>");
  if ("tool" in line || "calls" in line || "group" in line || "from" in line || "image" in line) return true;
  return !line.continuation && !!line.md.trim();
}

/** History at the current width; one neutral blank between logical blocks, never doubling an existing markdown blank. `previous` supports incremental commits. */
export function historyRows(lines: readonly Shown[], cols: number, previous?: Shown): string[] {
  const out: string[] = [];
  let tail = previous === undefined ? "" : lineRows(previous, cols).at(-1) ?? "";
  for (const line of lines) {
    const rows = lineRows(line, cols);
    if (startsBlock(line) && Bun.stripANSI(tail).trim() && Bun.stripANSI(rows[0] ?? "").trim()) out.push("");
    out.push(...rows);
    tail = rows.at(-1) ?? "";
    previous = line;
  }
  return out;
}
