import { modelRequestText, type Entry } from "../../protocol";

/** Runtime metadata is status feedback, never a conversation message. */
export function entryNotice(entry: Entry): string | undefined {
  if (entry.type === "model-request") return modelRequestText(entry);
  if (entry.type === "meta") return `${entry.role}${entry.branch ? ` on ${entry.branch}` : ""} (${entry.model || "default model"})`;
  if (entry.type === "summary") return "earlier conversation summarized";
  if (entry.type === "tool-recovery") return "interrupted tool calls completed as errors; outcome unknown—reconcile before retrying";
}

/** Compatibility for agents without structured tool hooks: tool output is conversation content. */
export const plainToolLine = (text: string) => /^(?:⏺|▸|⎿) /.test(Bun.stripANSI(text).trimStart());
