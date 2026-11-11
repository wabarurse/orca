import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { withStorageLock } from "../storage-lock";
import { put } from "./inbox";
import { withProjectStateLock } from "../projects";
import type { Message } from "../../../protocol";

/** Move only unread events for this command. Publication precedes deletion;
 * stable event IDs make a crash/retry safe for the destination's receipts. */
export async function transferProcessEvents(project: string, from: string, to: string, processId: string): Promise<void> {
  if (from === to) return;
  const dir = join(paths.inbox(project), from);
  const lock = <T>(fn: () => Promise<T>) => from === "orchestrator" ? withProjectStateLock(project, fn) : withStorageLock(`${dir}.lock`, fn);
  const messages = await lock(async () => {
    const result: { path: string; message: Message }[] = [];
    for (const name of (await readdir(dir).catch(error => { if (error.code === "ENOENT") return []; throw error; })).sort()) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name), message = await Bun.file(path).json() as Message;
      if (message.event?.processId !== processId) continue;
      result.push({ path, message });
    }
    return result;
  });
  // Never hold one agent's inbox lock while publishing to another (opposite
  // handoffs can cross). An in-flight consumer may also see the same event;
  // each inbox's exact event receipt still makes replay idempotent.
  for (const { path, message } of messages) {
    await put(project, to, message);
    await lock(() => unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }));
  }
}
