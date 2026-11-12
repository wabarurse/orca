import { rm } from "node:fs/promises";
import { join } from "node:path";
import { listProcesses, unresolvedProcess, processDirectory, type ProcessRecord } from "./store";
import { workspaces } from "../projects";

export const PROCESS_HISTORY = 512;
/** Called under the admission lock when history is full: drop the oldest handles that `process forget`
 * would accept (settled, nothing pending, every event delivered) until a batch of room exists.
 * False when nothing could be dropped, so the caller still refuses. */
export async function makeProcessRoom(project: string, records: ProcessRecord[], cap = PROCESS_HISTORY, room = Math.ceil(cap / 8)): Promise<boolean> {
  if (records.length < cap) return true;
  const done = records.filter(p => !unresolvedProcess(p) && !p.custody?.pending && p.events.every(e => e.delivered))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, records.length - cap + room);
  for (const p of done) await rm(processDirectory(project, p.id), { recursive: true, force: true });
  return records.length - done.length < cap;
}

export async function pruneSettledProcesses(project: string, apply = false) {
  const candidates = (await listProcesses(project)).filter(p => !unresolvedProcess(p) && !p.custody?.pending && p.events.every(e => e.delivered))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const changes: { path: string; disposition: string }[] = [];
  let bytes = 0;
  for (const p of candidates) {
    if (workspaces.resource(project, "process", p.id)) continue;
    const path = processDirectory(project, p.id);
    bytes += (Bun.file(join(path, "output.txt")).size || 0) + (Bun.file(join(path, "supervisor.log")).size || 0);
    const updated = Date.parse(p.updatedAt);
    if (!Number.isFinite(updated) || (Date.now() - updated < 7 * 86400_000 && bytes <= 1024 ** 3)) continue;
    if (apply) await rm(path, { recursive: true });
    changes.push({ path, disposition: apply ? "removed settled process output" : "eligible: settled process output exceeds age or storage budget" });
  }
  return changes;
}
