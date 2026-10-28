import { imageContent, validateRefs } from "../images";
import { format, type Message } from "../../../protocol";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { withStorageLock } from "../storage-lock";
import { projectIdentity, assertProjectIdentity, withProjectStateLock } from "../projects";
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
import { paths } from "../../../config";

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
  const full: Message = { ...structuredClone(msg), ...(msg.from === "user" ? { userEpoch: msg.userEpoch ?? inputEpoch(project) } : {}), ts: new Date().toISOString() };
  const n = String(seq++).padStart(6, "0");
  const name = full.event
    ? `${full.event.at.replaceAll(":", "-")}-event-${full.event.id}.json`
    : `${full.ts.replaceAll(":", "-")}-${n}-${crypto.randomUUID().slice(0, 8)}.json`;
  if (full.event && !/^[a-f0-9-]+$/.test(full.event.id)) throw new Error("invalid runtime event identity");
  const tmp = join(d, `.${name}.tmp`);
  const publish = async () => {
    assertProjectIdentity(project, identity);
    await validateRefs(project, full.attachments);
    await Bun.write(tmp, JSON.stringify(full) + "\n");
    await rename(tmp, join(d, name));
    return full;
  };
  // Clear and orchestrator input publication share the project lock. A send
  // published after a clear is new input, never silently discarded by it.
  const done = (writing.get(d) ?? Promise.resolve()).then(() => to === "orchestrator"
    ? withProjectStateLock(project, publish) : withStorageLock(`${d}.lock`, publish));
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

/** Preserve prompt/image association in inbox order; legacy text stays byte-identical. */
export function content(msgs: Message[]): MessageParam["content"] {
  if (!msgs.some(m => m.attachments?.length)) return format(msgs);
  return msgs.flatMap(m => {
    const blocks = imageContent(`[${m.from}] ${m.text}`, m.attachments);
    return typeof blocks === "string" ? [{ type: "text" as const, text: blocks }] : blocks;
  });
}

/** What consume() needs of a transcript (transcripts/transcript.ts `Transcript` satisfies it): a refreshed snapshot and its receipts. */
export interface ConsumeTarget {
  /** Read-only snapshot replacement. Call only at a safe context boundary. */
  refresh?(): Promise<void>;
  /** Includes compacted/cleared/branched-away records: durable consumption never expires. */
  consumed?(): { deliveries: Set<string>; inputs: Set<string>; epochs: Set<string> };
}

/** Commit inbox payload AND exact delivery evidence before deleting any files.
 * An interrupted cleanup is retried without resending already committed input.
 * The consumer owns its turn separately; this lock protects the inbox transaction.
 * commitEmpty lets launch atomically append its next instruction after all queued
 * deliveries, even when empty. Non-orchestrator puts share this lock: a racing
 * send is wholly before the launch instruction or remains queued after it.
 */
export async function consume(project: string, agent: string, transcript: ConsumeTarget,
  commit: (messages: (Message & { deliveryId: string })[]) => Promise<unknown>, commitEmpty = false): Promise<Message[]> {
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
      await validateRefs(project, m.attachments);
      fresh.push({ ...m, deliveryId });
      if (m.from === "user" && m.inputId) receipts?.inputs.add(m.inputId);
    }
    if (fresh.length || commitEmpty) await commit(fresh);
    // Publication is committed. Cleanup errors must NOT make callers resend.
    for (const name of names) await unlink(join(d, name)).catch(() => {});
    return fresh;
  });
}
