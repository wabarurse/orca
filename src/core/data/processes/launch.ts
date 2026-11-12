import { projectIdentity, workspaces } from "../projects";
import { execution } from "../projects/lifecycle";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { withStorageLock } from "../storage-lock";
import { makeProcessRoom } from "./retention";
import { addProcessEvent, listProcesses, liveProcess, unresolvedProcess, processOwner, reconcileProcesses, processDirectory, processOutput, readProcess, saveProcess, type ProcessRecord } from "./store";

/** Where an agent's commands save screenshots, logs and other evidence: inside tool-outputs, so read can open it and clean prunes it. */
export const evidenceDirectory = (project: string, owner: string) => join(paths.project(project), "tool-outputs", "evidence", owner);

export async function launchProcess(record: ProcessRecord, executable: string[], yieldMs: number, signal?: AbortSignal, admittedEpoch?: string) {
  signal?.throwIfAborted();
  const epoch = admittedEpoch ?? execution.epoch(record.project);
  execution.assertActive(record.project, epoch);
  await reconcileProcesses(record.project);
  record.incarnation = projectIdentity(record.project);
  const owner = workspaces.resource(record.project, "agent", record.owner)?.owners.map(workspaces.get).find(w => w && !w.cleanedAt);
  record.workspaceSession = workspaces.own(record.project, "process", record.id, { directory: owner?.path ?? record.cwd })?.id;
  const existing = await withStorageLock(join(processDirectory(record.project), "admission.lock"), async () => {
    execution.assertActive(record.project, epoch);
    const records = await listProcesses(record.project);
    const watch = record.prChecks;
    if (watch) {
      const current = records.find(p => !p.prWatch && unresolvedProcess(p) && p.prChecks?.repository === watch.repository &&
        p.prChecks.number === watch.number && p.prChecks.head === watch.head);
      if (current) return current;
    }
    if (records.filter(p => !p.prWatch && unresolvedProcess(p)).length >= 16) throw new Error("project already has 16 active or unresolved commands; inspect status for cleanup blockers");
    if (!await makeProcessRoom(record.project, records)) throw new Error("process history is full of unsettled or undelivered handles; inspect them with process list");
    await saveProcess(record);
    await Bun.write(join(processDirectory(record.project, record.id), "execution-epoch"), epoch);
    // Every command gets the same evidence folder, so agents never invent one elsewhere in the home; a sandbox command sets its own.
    const evidence = evidenceDirectory(record.project, record.owner);
    await mkdir(evidence, { recursive: true });
    const log = await open(join(processDirectory(record.project, record.id), "supervisor.log"), "a", 0o600);
    try {
      const child = Bun.spawn([...executable, "process-supervisor", "--project", record.project, "--process", record.id], {
        cwd: record.cwd, env: { ...process.env, ORCA_HOME: paths.root, ORCA_ARTIFACTS: evidence }, detached: true, stdin: "ignore", stdout: log.fd, stderr: log.fd,
      });
      child.unref();
    } catch (error) {
      record.state = "failed"; record.reason = "supervisor could not start"; await addProcessEvent(record, "failed"); throw error;
    } finally { await log.close(); }
  });
  if (existing) return { process: existing.id, state: existing.state, owner: processOwner(existing), reused: true };
  const deadline = Date.now() + yieldMs;
  do {
    const p = await readProcess(record.project, record.id);
    if (signal?.aborted) {
      await Bun.write(join(processDirectory(record.project, record.id), "stop"), "cancelled by caller\n");
      signal.throwIfAborted();
    }
    if (!liveProcess(p) || Date.now() >= deadline) return { process: p.id, state: p.state, exitCode: p.exitCode, output: await processOutput(p.project, p.id) };
    await Bun.sleep(25);
  } while (true);
}
