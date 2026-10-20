// One file per message. `inbox` holds messages to the orchestrator from
// workers, reviewers and the user; `outbox` holds the orchestrator's replies
// for whoever is connected (the terminal now, Instinct over HTTP in M3).
// Every client goes through here, so there is one code path.

import { mkdirSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";

export type Box = "inbox" | "outbox";

export interface Message {
  from: string;
  text: string;
  ts: string;
}

function dir(project: string, box: Box): string {
  return box === "inbox" ? paths.inbox(project) : join(paths.project(project), "outbox");
}

// Two puts in the same millisecond share a timestamp, so a per-process
// sequence number breaks the tie and keeps "oldest first" true within a
// process. Across processes the order inside one millisecond doesn't matter.
let seq = 0;

export async function put(project: string, msg: Omit<Message, "ts">, box: Box = "inbox"): Promise<Message> {
  const d = dir(project, box);
  mkdirSync(d, { recursive: true });
  const full: Message = { ...msg, ts: new Date().toISOString() };
  // ts, then seq, so a plain sort is oldest-first; a random tail avoids collisions between processes.
  const n = String(seq++).padStart(6, "0");
  const name = `${full.ts.replaceAll(":", "-")}-${n}-${crypto.randomUUID().slice(0, 8)}-${msg.from}.json`;
  await Bun.write(join(d, name), JSON.stringify(full) + "\n");
  return full;
}

/** Read and delete every message, oldest first. */
export async function drain(project: string, box: Box = "inbox"): Promise<Message[]> {
  const d = dir(project, box);
  mkdirSync(d, { recursive: true });
  const names = (await readdir(d)).filter((n) => n.endsWith(".json")).sort();
  const out: Message[] = [];
  for (const name of names) {
    const path = join(d, name);
    try {
      out.push((await Bun.file(path).json()) as Message);
    } catch {
      // A partial file from a crash mid-write; drop it.
    }
    await unlink(path);
  }
  return out;
}
