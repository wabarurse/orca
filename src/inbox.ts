import { inputEpoch } from "./user-input";
// Every agent has its own inbox: a durable FIFO queue of files under
// inbox/<agent>/. Anyone can put a message in anyone's inbox; only the owner
// drains it. "user" is an address like any other, drained by the TUI.
//
// Guarantees: a message is written atomically (tmp + rename), delivered once,
// and read in send order within a process. Nothing is lost if the receiver
// isn't running; it waits in the queue until the agent next drains.

import { mkdirSync } from "node:fs";
import { readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";

export interface Message {
  /** Captured when submitted, never when the asynchronous write finishes. */
  userEpoch?: string;
  from: string;
  text: string;
  ts: string;
}

const dir = (project: string, agent: string) => join(paths.inbox(project), agent);

// Two puts in the same millisecond share a timestamp, so a per-process
// sequence number breaks the tie. Across processes the order inside one
// millisecond doesn't matter.
let seq = 0;

// Puts to one inbox from this process land one after another, in send order:
// otherwise a later message could be renamed into place before an earlier one
// and a drain in between would read it first (two lines typed quickly).
const writing = new Map<string, Promise<unknown>>();

/** Append a message to `to`'s inbox. */
export async function put(project: string, to: string, msg: Omit<Message, "ts">): Promise<Message> {
  const d = dir(project, to);
  mkdirSync(d, { recursive: true });
  const full: Message = { ...msg, ...(msg.from === "user" ? { userEpoch: msg.userEpoch ?? inputEpoch(project) } : {}), ts: new Date().toISOString() };
  const n = String(seq++).padStart(6, "0");
  const name = `${full.ts.replaceAll(":", "-")}-${n}-${crypto.randomUUID().slice(0, 8)}.json`;
  const tmp = join(d, `.${name}.tmp`);
  const done = (writing.get(d) ?? Promise.resolve()).then(async () => {
    await Bun.write(tmp, JSON.stringify(full) + "\n");
    await rename(tmp, join(d, name));
    return full;
  });
  const tail = done.catch(() => {});
  writing.set(d, tail);
  tail.then(() => { if (writing.get(d) === tail) writing.delete(d); });
  return done;
}

/** True when `agent` has unread messages. */
export async function pending(project: string, agent: string): Promise<boolean> {
  return (await readdir(dir(project, agent)).catch(() => [])).some((n) => n.endsWith(".json"));
}

/** A new human message can resume a cancelled orchestrator without consuming agent reports. */
export async function userInEpoch(project: string, agent: string, epoch: string): Promise<boolean> {
  const d = dir(project, agent);
  for (const name of (await readdir(d).catch(() => [])).filter(n => n.endsWith(".json"))) {
    const message = await Bun.file(join(d, name)).json().catch(() => null) as Message | null;
    if (message?.from === "user" && message.userEpoch === epoch) return true;
  }
  return false;
}

/** Read and delete every message in `agent`'s inbox, oldest first. */
export async function drain(project: string, agent: string): Promise<Message[]> {
  const d = dir(project, agent);
  const names = (await readdir(d).catch(() => [])).filter((n) => n.endsWith(".json")).sort();
  const out: Message[] = [];
  for (const name of names) {
    const path = join(d, name);
    try {
      out.push((await Bun.file(path).json()) as Message);
    } catch {
      // Not valid JSON; drop it rather than block the queue.
    }
    await unlink(path);
  }
  return out;
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
