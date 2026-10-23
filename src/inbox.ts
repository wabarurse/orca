import { withStorageLock } from "./storage-lock";
import type { Transcript } from "./transcript";
import { projectIdentity, assertProjectIdentity, withProjectStateLock } from "./project-state";
import { inputEpoch } from "./user-input";
// Every agent has its own inbox: a durable FIFO queue of files under
// inbox/<agent>/. Anyone can put a message in anyone's inbox; only the owner
// drains it. "user" is an address like any other, drained by the TUI.
//
// Publication is atomic (tmp + rename), ordered within a process. Context
// consumers commit payload + exact delivery receipts before unlinking inbox files.
// Legacy drain is destructive and only suitable for non-context callers. When
// the receiver is not running, input waits until its next consumption transaction.

import { mkdirSync } from "node:fs";
import { readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";

export interface Message {
  /** Optional immutable identity of a locally submitted prompt; echoed unchanged at consumption. */
  inputId?: string;
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
  const identity = projectIdentity(project);
  const full: Message = { ...msg, ...(msg.from === "user" ? { userEpoch: msg.userEpoch ?? inputEpoch(project) } : {}), ts: new Date().toISOString() };
  const n = String(seq++).padStart(6, "0");
  const name = `${full.ts.replaceAll(":", "-")}-${n}-${crypto.randomUUID().slice(0, 8)}.json`;
  const tmp = join(d, `.${name}.tmp`);
  const publish = async () => {
    assertProjectIdentity(project, identity);
    await Bun.write(tmp, JSON.stringify(full) + "\n");
    await rename(tmp, join(d, name));
    return full;
  };
  // Clear and orchestrator input publication share the project lock. A send
  // published after a clear is new input, never silently discarded by it.
  const done = (writing.get(d) ?? Promise.resolve()).then(() => to === "orchestrator"
    ? withProjectStateLock(project, publish) : publish());
  const tail = done.catch(() => {});
  writing.set(d, tail);
  tail.then(() => { if (writing.get(d) === tail) writing.delete(d); });
  return done;
}

/** True when `agent` has unread messages. */
export async function pending(project: string, agent: string): Promise<boolean> {
  return (await readdir(dir(project, agent)).catch(() => [])).some((n) => n.endsWith(".json"));
}

/** Fail-closed clear guard, including local writes not yet durably published.
 * Call under the project-state lock to exclude concurrent orchestrator puts.
 * Unlike polling, unreadable directories are errors, not an empty inbox.
 */
export async function pendingInput(project: string, agent: string): Promise<boolean> {
  const d = dir(project, agent);
  const names = await readdir(d).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return writing.has(d) || names.some(n => n.endsWith(".json") || n.endsWith(".tmp"));
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
  return withStorageLock(`${d}.lock`, async () => {
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
  });
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

/** Commit inbox payload AND exact delivery evidence before deleting any files.
 * An interrupted cleanup is retried without resending already committed input.
 * The consumer owns its turn separately; this lock protects the inbox transaction.
 */
export async function consume(project: string, agent: string, transcript: Transcript,
  commit: (messages: (Message & { deliveryId: string })[]) => Promise<unknown>): Promise<Message[]> {
  const d = dir(project, agent);
  return withStorageLock(`${d}.lock`, async () => {
    await transcript.refresh?.();
    const receipts = transcript.consumed?.();
    const names = (await readdir(d).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    })).filter(n => n.endsWith(".json")).sort();
    const fresh: (Message & { deliveryId: string })[] = [];
    for (const name of names) {
      const deliveryId = `${agent}/${name}`;
      if (receipts?.deliveries.has(deliveryId)) continue;
      // Fail closed on invalid/unreadable input: never silently drop a prompt.
      const m = await Bun.file(join(d, name)).json() as Message;
      if (typeof m.from !== "string" || typeof m.text !== "string") throw new Error(`invalid inbox message ${name}`);
      if (m.from === "user" && m.inputId && receipts?.inputs.has(m.inputId)) continue;
      fresh.push({ ...m, deliveryId });
      if (m.from === "user" && m.inputId) receipts?.inputs.add(m.inputId);
    }
    if (fresh.length) await commit(fresh);
    // Publication is committed. Cleanup errors must NOT make callers resend.
    for (const name of names) await unlink(join(d, name)).catch(() => {});
    return fresh;
  });
}
