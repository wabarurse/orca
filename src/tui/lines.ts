// What a page's history holds, and how one entry is laid out on screen.

import { renderBlock, renderLabelled, renderMarkdown } from "./markdown";
import { userRows } from "./render";
import { toolRows } from "./tools";
import type { ToolView } from "../toolview";

/**
 * A line of history. Plain text stays as it is; the orchestrator's markdown is
 * kept as written (`md`: one streamed block, or a whole text led by `label`)
 * and laid out at the current width whenever it is drawn, so a reprint after a
 * resize fits tables to the new width. A line of the user's own message
 * (`user`, "> …" or its indented continuation) is drawn on the user
 * background, full width (render.ts `userRows`). A finished tool call
 * (`tool`, its `summary`, `failed`) shows as its "⏺" line and "⎿" summary,
 * cut to the width (tools.ts `toolRows`).
 */
export type Line = string | { md: string; block?: boolean; label?: string } | { user: string } | ToolView;

/** A history line as screen lines at `cols` columns. */
export function lineRows(l: Line, cols: number): string[] {
  if (typeof l === "string") return [l];
  if ("user" in l) return userRows(l.user, cols);
  if ("tool" in l) return toolRows(l, cols);
  if (l.block) return renderBlock(l.md, cols);
  return l.label ? renderLabelled(l.label, l.md, cols) : renderMarkdown(l.md, cols);
}

/** A logical boundary, not a wrapped row or a chunk of a still-streaming paragraph. */
function startsBlock(line: Line, previous?: Line): boolean {
  if (typeof line === "string") return false;
  if ("user" in line) return line.user.startsWith("\x1b[1m>");
  if ("tool" in line) return true;
  if (previous && typeof previous !== "string" && "md" in previous && continuesList(previous.md, line.md)) return false;
  return !!line.md.trim();
}

/** Adjacent list items/indented continuation lines belong to one markdown list. */
function continuesList(before: string, after: string): boolean {
  const list = /^\s*(?:[-+*] |\d+[.)] )/;
  return list.test(before) && (list.test(after) || /^ {2,}\S/.test(after));
}

/** History at the current width; one neutral blank between logical blocks, never doubling an existing markdown blank. `previous` supports incremental commits. */
export function historyRows(lines: Line[], cols: number, previous?: Line): string[] {
  const out: string[] = [];
  let tail = previous === undefined ? "" : lineRows(previous, cols).at(-1) ?? "";
  for (const line of lines) {
    const rows = lineRows(line, cols);
    if (startsBlock(line, previous) && Bun.stripANSI(tail).trim() && Bun.stripANSI(rows[0] ?? "").trim()) out.push("");
    out.push(...rows);
    tail = rows.at(-1) ?? "";
    previous = line;
  }
  return out;
}
