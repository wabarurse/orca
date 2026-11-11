import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { paths } from "../../../config";
import { execution } from "../projects/lifecycle";
import { withStorageLock } from "../storage-lock";
import { deliverProcessEvents, processDirectory, processOwner, readProcess, saveCustody } from "./store";

/** Transfer control and events, never the command's identity, epoch or workspace.
 * Routing is separate from supervisor state so its next write cannot undo it. */
export async function handoffProcess(project: string, id: string, input: { actor: string; to: string; reason: string; epoch?: string }) {
  const epoch = input.epoch ?? execution.epoch(project);
  execution.assertActive(project, epoch);
  if (!/^(orchestrator|(?:worker|reviewer)(?:-[A-Za-z0-9._-]+)?)$/.test(input.to)) throw new Error("handoff requires an agent in this conversation");
  if (!input.reason.trim() || input.reason.length > 1000) throw new Error("handoff requires a short reason and remaining responsibility");
  if (input.to !== "orchestrator" && !await Bun.file(paths.transcript(project, input.to)).exists()) throw new Error("handoff destination does not exist in this conversation");
  await withStorageLock(join(processDirectory(project, id), "routing.lock"), async () => {
    execution.assertActive(project, epoch);
    const p = await readProcess(project, id), owner = processOwner(p);
    if (input.actor !== "orchestrator" && input.actor !== owner) throw new Error("process belongs to another agent");
    if (p.prWatch && input.to !== "orchestrator") throw new Error("ongoing PR watches belong to the orchestrator");
    if (p.verification) throw new Error("sandbox commands retain their environment's lifetime; hand off a standalone command instead");
    const admitted = await Bun.file(join(processDirectory(project, id), "execution-epoch")).text().catch(() => epoch);
    execution.assertActive(project, admitted);
    if (p.custody?.pending) throw new Error("previous handoff is awaiting delivery; inspect status and retry");
    if (owner === input.to) return;
    await withStorageLock(join(processDirectory(project, id), "record.lock"), async () => {
      const active = join(processDirectory(project), "active");
      await mkdir(active, { recursive: true });
      await writeFile(join(active, id), "\n", { mode: 0o600 });
      const routing = join(processDirectory(project), "handoffs");
      await mkdir(routing, { recursive: true });
      await writeFile(join(routing, id), "\n", { mode: 0o600 });
      await saveCustody(project, id, { owner: input.to, from: owner, id: crypto.randomUUID(), at: new Date().toISOString(), reason: input.reason, pending: true });
    });
  });
  await deliverProcessEvents(await readProcess(project, id));
  const p = await readProcess(project, id);
  return { process: id, owner: processOwner(p), state: p.state, handedOff: true, running: p.state === "running", restarted: false };
}
