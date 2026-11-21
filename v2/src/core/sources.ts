// The user's own messages in a conversation: the only sources an explicit behavior line may cite.
import { paths } from "../config";
import { openTranscript } from "./transcript";

export type HumanMessage = { id: string; text: string; at: string };

export function humanMessages(conversation: string): HumanMessage[] {
  const transcript = openTranscript(paths.transcript(conversation, "orchestrator"));
  const out: HumanMessage[] = [];
  for (const entry of transcript.all()) {
    if (entry.type !== "message") continue;
    for (const message of entry.inbox) if (message.from === "user") out.push({ id: message.id, text: message.text, at: message.ts });
  }
  return out;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The message a source names by id, or quotes verbatim (8+ characters, whitespace-insensitive). */
export function resolveSource(source: string, candidates: HumanMessage[]): { id: string; quote: string } | null {
  const trimmed = source.trim();
  const byId = candidates.find(message => trimmed.includes(message.id));
  const quoted = /"([^"]{8,})"/.exec(trimmed)?.[1] ?? (trimmed.length >= 8 ? trimmed : "");
  const found = byId ?? (quoted.length > 0 ? candidates.findLast(message => squash(message.text).includes(squash(quoted))) : undefined);
  if (found === undefined) return null;
  const text = found.text.replace(/\s+/g, " ").trim();
  return { id: found.id, quote: text.length > 120 ? `${text.slice(0, 117)}…` : text };
}

export function sourceChoices(candidates: HumanMessage[]): string {
  const recent = candidates.slice(-8);
  return recent.length === 0 ? "(no user messages yet)" : recent.map(message => `- ${message.id}: ${JSON.stringify(message.text.replace(/\s+/g, " ").slice(0, 80))}`).join("\n");
}
