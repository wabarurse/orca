import type { Row, Section } from "../core/plugins/types";
import type { ShelfEntry } from "../core/shelf";

export const ARCHIVE_HEADING = "archive:heading";

export const isHeading = (row: Row | undefined): boolean => row !== undefined && row.id === ARCHIVE_HEADING;

export function shelved(rows: Row[], entry: ShelfEntry, open: boolean): Row[] {
  const active = rows.filter(r => entry.archived[r.id] === undefined);
  const archived = rows.filter(r => entry.archived[r.id] !== undefined);
  if (archived.length === 0) return active;
  const heading: Row = { id: ARCHIVE_HEADING, name: `${open ? "▾" : "▸"} Archived (${archived.length})`, status: "", info: open ? "enter closes · u restores" : "enter opens", tone: "dim" };
  return [...active, heading, ...(open ? archived.map(r => ({ ...r, tone: "dim" as const })) : [])];
}

export function archivedSection(entry: ShelfEntry, row: Row): Section[] {
  const at = entry.archived[row.id];
  return at === undefined ? [] : [{ title: "Archived", lines: [`archived ${at.slice(0, 16).replace("T", " ")}; u restores it`] }];
}
