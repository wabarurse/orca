import { projectIdentity } from "../projects";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../../config";
import { withStorageLock } from "../storage-lock";
import { addProcessEvent, listProcesses, liveProcess, processDirectory, processOutput, readProcess, saveProcess, type ProcessRecord } from "./store";

export async function launchProcess(record: ProcessRecord, executable: string[], yieldMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  record.incarnation = projectIdentity(record.project);
  await withStorageLock(join(processDirectory(record.project), "admission.lock"), async () => {
    if ((await listProcesses(record.project)).filter(p => liveProcess(p) || p.state === "unknown").length >= 16) throw new Error("project already has 16 active commands; stop or finish existing work");
    if ((await listProcesses(record.project)).length >= 512) throw new Error("process history is full; forget terminal handles with process before launching more");
    await saveProcess(record);
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
