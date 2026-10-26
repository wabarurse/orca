// The inbox message record (core/data/inbox/inbox.ts queues and consumes them)
// and its pure text form: `format` tags messages as one user turn, `parseFormatted`
// reads a formatted turn back (the TUI's restore).

import type { ImageRef } from "./images";

export interface Message {
  /** Optional immutable identity of a locally submitted prompt; echoed unchanged at consumption. */
  inputId?: string;
  attachments?: ImageRef[];
  /** Captured when submitted, never when the asynchronous write finishes. */
  userEpoch?: string;
  from: string;
  text: string;
  ts: string;
}

/** Messages as one user turn, each tagged with its sender. */
export function format(msgs: Message[]): string {
  return msgs.map((m) => `[${m.from}] ${m.text}`).join("\n\n");
}

/** A real sender id, as `format` tags it: "user", "orchestrator" or an agent's session id. */
const SENDER = String.raw`(?:user|orchestrator|(?:worker|reviewer)(?:-[\w.-]+)?)`;
const TAGGED = new RegExp(String.raw`^\[(${SENDER})\] ([\s\S]*)$`);
const NEXT = new RegExp(String.raw`\n\n(?=\[${SENDER}\] )`);

/**
 * The messages a `format`ted turn holds, in order: the inverse of `format`.
 * Only real sender ids count as tags, so "[x] done" or "[1] item" inside a
 * message stays part of it. Text that is not a formatted turn comes back as
 * one message from nobody (""). For reading old turns back (the TUI's
 * restore); live code gets the messages themselves.
 */
export function parseFormatted(text: string): Pick<Message, "from" | "text">[] {
  if (!TAGGED.test(text)) return [{ from: "", text }];
  const out: Pick<Message, "from" | "text">[] = [];
  for (const chunk of text.split(NEXT)) {
    const m = TAGGED.exec(chunk);
    // A split only happens before a tag, so every chunk is tagged.
    if (m) out.push({ from: m[1]!, text: m[2]! });
  }
  return out;
}
