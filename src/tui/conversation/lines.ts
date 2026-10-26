// What a page's history holds, and how one entry is laid out on screen.

import { renderBlock, renderLabelled, renderMarkdown } from "./markdown";
import { sanitize, wrap } from "../components/text";
import { fillRow, userFill } from "../components/style";
import { groupRow, toolRows } from "./tools";
import type { ToolView } from "../../core/agent-loop/loop/toolview";

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
export type Line = string | { md: string; block?: boolean; label?: string; continuation?: true } | { user: string } | ToolView;

/** A line as shown: a history line, or a run of finished calls folded into one (`calls`, tools.ts `collapseCalls`) for the collapsed view, one summary row (`groupRow`), with every call indented under it once a click opened it (`open`). The history itself never holds one. */
export type Shown = Line | { calls: ToolView[]; open?: true };

/** A history line as screen lines at `cols` columns. */
export function lineRows(l: Shown, cols: number): string[] {
  if (typeof l === "string") return [l];
  if ("user" in l) return userRows(l.user, cols);
  if ("tool" in l) return toolRows(l, cols);
  if ("calls" in l) return [groupRow(l.calls, cols, l.open), ...(l.open ? l.calls.flatMap((c) => toolRows(c, Math.max(1, cols - 2)).map((r) => `  ${r}`)) : [])];
  if (l.block) return renderBlock(l.md, cols);
  return l.label ? renderLabelled(l.label, l.md, cols) : renderMarkdown(l.md, cols);
}

/** A logical boundary, not a wrapped row or a chunk of a still-streaming paragraph. */
function startsBlock(line: Shown): boolean {
  if (typeof line === "string") return false;
  if ("user" in line) return line.user.startsWith("\x1b[1m>");
  if ("tool" in line || "calls" in line) return true;
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
