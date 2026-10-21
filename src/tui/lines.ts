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
