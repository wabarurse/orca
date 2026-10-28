import { modelRequestText, type Entry } from "../../protocol";

/** Runtime metadata is status feedback, never a conversation message. */
export function entryNotice(entry: Entry): string | undefined {
  if (entry.type === "model-request") return modelRequestText(entry);
  if (entry.type === "meta") return `${entry.role}${entry.branch ? ` on ${entry.branch}` : ""} (${entry.model || "default model"})`;
  if (entry.type === "summary") return "earlier conversation summarized";
  if (entry.type === "tool-recovery") return "interrupted tool calls completed as errors; outcome unknown—reconcile before retrying";
}

/** Restored metadata shares the live status row, scoped to the latest clear. */
export function transcriptStatus(entries: Entry[]) {
  const boundary = entries.findLastIndex(entry => entry.type === "context-boundary");
  const at = entries.findLastIndex(entry => entryNotice(entry) !== undefined);
  const entry = at > boundary ? entries[at] : undefined;
  return { boundary: entries[boundary]?.uuid,
    notice: entry ? { id: entry.uuid, text: entryNotice(entry)! } : undefined };
}

/** Compatibility for agents without structured tool hooks: tool output is conversation content. */
export const plainToolLine = (text: string) => /^(?:⏺|▸|⎿) /.test(Bun.stripANSI(text).trimStart());
