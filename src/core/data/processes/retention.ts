import { rm } from "node:fs/promises";
import { join } from "node:path";
import { listProcesses, liveProcess, processDirectory } from "./store";
import { workspaces } from "../projects";

export async function pruneSettledProcesses(project: string, apply = false) {
  const candidates = (await listProcesses(project)).filter(p => !liveProcess(p) && p.state !== "unknown" && p.events.every(e => e.delivered))
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
