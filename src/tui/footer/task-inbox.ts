import { publicTaskStatus } from "../../protocol/task-ledger";
import { taskPublicationMilestone } from "../../protocol/tasks";
// Read-only presentation of the durable registry. Never inspect agents/transcripts.
import { taskPR, taskStatusLabels, type TaskRow } from "../../protocol";
import { wordWrap } from "../components";
import { bold, plainText, visibleLength, wrap } from "../components";

export interface TaskInboxData {
  rows?: TaskRow[];
  loading: boolean;
  error?: string;
}

interface RefreshableTaskInbox extends TaskInboxData {
  pending?: Promise<void>;
  refreshAgain?: boolean;
}

/** Coalesce reads, not invalidations: a poll arriving during a snapshot needs a
 * trailing read. The captured panel/page must still own every published result. */
export function refreshTaskInboxData(data: RefreshableTaskInbox, read: () => Promise<TaskRow[]>, current: () => boolean, changed: () => void): Promise<void> {
  data.refreshAgain = true;
  if (data.pending) return data.pending;
  data.loading = true;
  data.pending = Promise.resolve().then(async () => {
    do {
      data.refreshAgain = false;
      try {
        const rows = await read();
        if (!current()) return;
        data.rows = rows;
        data.error = undefined;
      } catch (err) {
        if (!current()) return;
        data.error = err instanceof Error ? err.message : String(err);
      }
      changed();
    } while (data.refreshAgain && current());
  }).finally(() => {
    data.pending = undefined;
    data.loading = false;
    if (current()) changed();
  });
  changed();
  return data.pending;
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
  catch { return "invalid pr link"; }
}

/** Full fields wrap (not silently truncated); narrow screens use labelled records.
 * The wide table header is pinned by the footer panel while its rows scroll. */
export function taskInboxLines(data: TaskInboxData, cols: number): { lines: string[]; heading?: string } {
  cols = Math.max(1, cols);
  const lines: string[] = [];
  if (data.error) {
    lines.push(...bounded(`inbox query failed: ${inboxText(data.error)}`, cols));
    if (data.rows) lines.push(...bounded("last successful snapshot below; may be stale. r retries.", cols));
    else lines.push(...bounded("tasks unavailable, not an empty inbox. r retries.", cols));
  } else if (data.loading) lines.push(...bounded(data.rows ? "refreshing task inbox…" : "loading task inbox…", cols));
  if (!data.rows) return { lines };
  if (!data.rows.length) {
    lines.push(...bounded(data.error ? "last successful snapshot had no listed tasks." : "no listed tasks.", cols));
    lines.push(...bounded("unregistered or historical work is not tracked here; this is not a completion claim.", cols));
    return { lines };
  }
  const wide = cols >= 72;
  const room = cols - 9; // three separators
  const nameWidth = Math.max(12, Math.floor(room * 0.2));
  const prWidth = Math.max(23, Math.floor(room * 0.33));
  const widths = [nameWidth, room - nameWidth - prWidth - 14, 14, prWidth];
  const tableRow = (cells: string[]) => cells.map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - visibleLength(cell)))).join(" | ");
  const labels = ["name", "summary", "status", "pr link"];
  for (const row of data.rows) {
    const url = prLink(row);
    // Add our own hyperlink only AFTER canonical PR validation and cell wrapping.
    // Each physical fragment closes its link, so styles/links cannot leak rows.
    const link = (text: string) => url.startsWith("https://github.com/") ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
    // Display precedence only: never change stored lifecycle, attention or reason.
    let milestone;
    try { milestone = taskPublicationMilestone(row); } catch { /* malformed proof stays unknown */ }
    const published = milestone?.kind === "published";
    const status = publicTaskStatus(row);
    const fields = [`#${row.number ?? "?"} ${inboxText(row.name)}`, inboxText(row.summary), status, url];
    const decorate = (part: string, i: number) => i === 3 ? link(part) : i === 2 && published ? `\x1b[32m${link(part)}\x1b[0m` : part;
    if (wide) {
      const cells = fields.map((text, i) => bounded(text, widths[i]!).map(part => decorate(part, i)));
      const height = Math.max(...cells.map(cell => cell.length));
      for (let i = 0; i < height; i++) lines.push(tableRow(cells.map(cell => cell[i] ?? "")));
    } else {
      fields.forEach((text, i) => lines.push(...bounded(`${labels[i]}: ${text}`, cols).map(part => decorate(part, i))));
    }
    if (row.attention) lines.push(...bounded(`attention: ${inboxText(row.attention.kind)}: ${inboxText(row.attention.reason)}`, cols));
    if (milestone && "observedAt" in milestone) lines.push(...bounded(`observed: ${milestone.observedAt} (historical; not merge permission)`, cols));
    lines.push("");
  }
  lines.pop();
  return { lines, ...(wide ? { heading: bold(tableRow(labels)) } : {}) };
}
