import { join } from "node:path";
import { paths, readProjectState, writeProjectState } from "../../../config";
import { projectIdentity, workspaces } from "../projects";
import { execution } from "../projects/lifecycle";
import { withStorageLock } from "../storage-lock";
import { makeProcessRoom } from "./retention";
import { listProcesses, liveProcess, processDirectory, reconcileProcesses, saveProcess, type ProcessRecord } from "./store";

type PR = { repository: string; number: number };
const stopKey = (pr: PR) => `pr-watch-stop:${pr.repository.toLowerCase()}#${pr.number}`;
export const prWatchEnabled = (project: string, pr: PR): boolean => readProjectState(project, stopKey(pr)) !== true;
export const setPRWatchEnabled = (project: string, pr: PR, enabled: boolean): void => writeProjectState(project, stopKey(pr), enabled ? undefined : true);

/** Register with the daemon's shared PR observer. No shell, supervisor, model
 * polling or worker lifetime is needed; updates go to the orchestrator. */
export async function registerPRWatch(project: string, watch: NonNullable<ProcessRecord["prChecks"]>, epoch = execution.epoch(project)) {
  execution.assertActive(project, epoch);
  await reconcileProcesses(project);
  return withStorageLock(join(processDirectory(project), "admission.lock"), async () => {
    execution.assertActive(project, epoch);
    const records = await listProcesses(project);
    const existing = records.find(p => p.prWatch && liveProcess(p) && p.watchEpoch === epoch &&
      p.prChecks?.repository === watch.repository && p.prChecks.number === watch.number);
    if (existing) { setPRWatchEnabled(project, watch, true); return { process: existing.id, state: "watching", owner: "orchestrator", reused: true, commandSlot: false }; }
    if (!await makeProcessRoom(project, records)) throw new Error("process history is full of unsettled or undelivered handles; inspect them with process list");
    const at = new Date().toISOString(), id = crypto.randomUUID(), cwd = paths.repo(project);
    const workspaceSession = workspaces.own(project, "process", id, { directory: cwd })?.id;
    await saveProcess({ project, id, owner: "orchestrator", role: "orchestrator", incarnation: projectIdentity(project), workspaceSession,
      cwd, command: `Observe PR ${watch.repository}#${watch.number}`, createdAt: at, updatedAt: at,
      state: "running", prWatch: true, watchEpoch: epoch, prChecks: watch, timeoutMs: 0, maxBytes: 0, notify: false, events: [] });
    setPRWatchEnabled(project, watch, true);
    return { process: id, state: "watching", owner: "orchestrator", reused: false, commandSlot: false };
  });
}
