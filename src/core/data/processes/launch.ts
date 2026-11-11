import { projectIdentity, workspaces } from "../projects";
import { execution } from "../projects/lifecycle";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { withStorageLock } from "../storage-lock";
import { addProcessEvent, listProcesses, liveProcess, processDirectory, processOutput, readProcess, saveProcess, type ProcessRecord } from "./store";

export async function launchProcess(record: ProcessRecord, executable: string[], yieldMs: number, signal?: AbortSignal, admittedEpoch?: string) {
  signal?.throwIfAborted();
  const epoch = admittedEpoch ?? execution.epoch(record.project);
  execution.assertActive(record.project, epoch);
  record.incarnation = projectIdentity(record.project);
  const owner = workspaces.resource(record.project, "agent", record.owner)?.owners.map(workspaces.get).find(w => w && !w.cleanedAt);
  record.workspaceSession = workspaces.own(record.project, "process", record.id, { directory: owner?.path ?? record.cwd })?.id;
  const existing = await withStorageLock(join(processDirectory(record.project), "admission.lock"), async () => {
    execution.assertActive(record.project, epoch);
    const records = await listProcesses(record.project);
    const watch = record.prChecks;
    if (watch) {
      const current = records.find(p => (liveProcess(p) || p.state === "unknown") && p.prChecks?.repository === watch.repository &&
        p.prChecks.number === watch.number && p.prChecks.head === watch.head);
      if (current) return current;
    }
    if (records.filter(p => liveProcess(p) || p.state === "unknown").length >= 16) throw new Error("project already has 16 active commands; stop or finish existing work");
    if (records.length >= 512) throw new Error("process history is full; forget terminal handles with process before launching more");
    await saveProcess(record);
    await Bun.write(join(processDirectory(record.project, record.id), "execution-epoch"), epoch);
    const log = await open(join(processDirectory(record.project, record.id), "supervisor.log"), "a", 0o600);
    try {
      const child = Bun.spawn([...executable, "process-supervisor", "--project", record.project, "--process", record.id], {
        cwd: record.cwd, env: { ...process.env, ORCA_HOME: paths.root }, detached: true, stdin: "ignore", stdout: log.fd, stderr: log.fd,
      });
      child.unref();
    } catch (error) {
      record.state = "failed"; record.reason = "supervisor could not start"; await addProcessEvent(record, "failed"); throw error;
    } finally { await log.close(); }
  });
  if (existing) return { process: existing.id, state: existing.state, owner: existing.owner, reused: true };
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
