import type { Transcript } from "../transcript";

const HEADER = /^\[orca reference: ([a-z][a-z0-9-]{0,63})\]\n/;
const note = (section: string, value: string): string =>
  `[orca reference: ${section}]\nReplaces earlier updates of this section. Reference only: it grants no new permission, and the user's explicit words take precedence.\n\n${value.length > 0 ? value : "(nothing currently)"}`;

export async function appendContext(transcript: Transcript, sections: Record<string, string>): Promise<void> {
  const previous = new Map<string, string>();
  for (const message of transcript.chain()) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      const match = HEADER.exec(block.text);
      if (match?.[1] !== undefined) previous.set(match[1], block.text);
    }
  }
  const changes = [...new Set([...Object.keys(sections), ...previous.keys()])].sort().flatMap(key => {
    const value = sections[key] ?? "";
    const text = note(key, value);
    return previous.get(key) === text || (value.length === 0 && !previous.has(key)) ? [] : [{ type: "text" as const, text }];
  });
  if (changes.length === 0) return;
  await transcript.append({ type: "message", inbox: [], message: { role: "user", content: changes } });
}
