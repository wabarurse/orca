// Read-only presentation of the durable registry. Never inspect agents/transcripts.
import { taskPR, taskStatusLabels, type TaskRow } from "../tasks";
import { wordWrap } from "./markdown";
import { bold, plainText, visibleLength, wrap } from "./render";

export interface TaskInboxData {
  rows?: TaskRow[];
  loading: boolean;
  error?: string;
}

/** Registry text is untrusted, even when it passed storage validation. No SGR,
 * OSC links, C0/C1 or bidi controls from fields/errors may reach the terminal. */
export const inboxText = plainText;
const bounded = (text: string, width: number) => wordWrap(text, width).flatMap(row => wrap(row, width));

/** Only the canonical structured URL, never a link found in name/summary/prose.
 * Visible URL text is also usable without OSC 8 support. No browser commands. */
function prLink(row: TaskRow): string {
  if (!row.pr) return "—";
  try { return taskPR(row.pr).url; }
  catch { return "Invalid PR link"; }
}

/** Full fields wrap (not silently truncated); narrow screens use labelled records.
 * The wide table header is pinned by the footer panel while its rows scroll. */
export function taskInboxLines(data: TaskInboxData, cols: number): { lines: string[]; heading?: string } {
  cols = Math.max(1, cols);
  const lines: string[] = [];
  if (data.error) {
    lines.push(...bounded(`Inbox query failed: ${inboxText(data.error)}`, cols));
    if (data.rows) lines.push(...bounded("Last successful snapshot below; may be stale. r retries.", cols));
    else lines.push(...bounded("Tasks unavailable, not an empty inbox. r retries.", cols));
  } else if (data.loading) lines.push(...bounded(data.rows ? "Refreshing task inbox…" : "Loading task inbox…", cols));
  if (!data.rows) return { lines };
  if (!data.rows.length) {
    lines.push(...bounded(data.error ? "Last successful snapshot had no active registered tasks." : "No active registered tasks.", cols));
    lines.push(...bounded("Unregistered or historical work is not tracked here; this is not a completion claim.", cols));
    return { lines };
  }
  const wide = cols >= 72;
  const room = cols - 9; // three separators
  const nameWidth = Math.max(12, Math.floor(room * 0.2));
  const prWidth = Math.max(23, Math.floor(room * 0.33));
  const widths = [nameWidth, room - nameWidth - prWidth - 14, 14, prWidth];
  const tableRow = (cells: string[]) => cells.map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - visibleLength(cell)))).join(" | ");
  const labels = ["Name", "Summary", "Status", "PR link"];
  for (const row of data.rows) {
    const url = prLink(row);
    // Add our own hyperlink only AFTER canonical PR validation and cell wrapping.
    // Each physical fragment closes its link, so styles/links cannot leak rows.
    const link = (text: string) => url.startsWith("https://github.com/") ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
    // Display precedence only: never change stored lifecycle, attention or reason.
    const fields = [inboxText(row.name), inboxText(row.summary), row.attention ? inboxText(row.attention.kind) : taskStatusLabels[row.status], url];
    if (wide) {
      const cells = fields.map((text, i) => bounded(text, widths[i]!).map(part => i === 3 ? link(part) : part));
      const height = Math.max(...cells.map(cell => cell.length));
      for (let i = 0; i < height; i++) lines.push(tableRow(cells.map(cell => cell[i] ?? "")));
    } else {
      fields.forEach((text, i) => lines.push(...bounded(`${labels[i]}: ${text}`, cols).map(part => i === 3 ? link(part) : part)));
    }
    lines.push("");
  }
  lines.pop();
  return { lines, ...(wide ? { heading: bold(tableRow(labels)) } : {}) };
}
