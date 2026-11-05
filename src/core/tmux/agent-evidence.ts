import type { RunState } from "./exits";

function processOwner(pid: number): number | null {
  const ps = Bun.which("ps");
  if (!ps) return null;
  try {
    const result = Bun.spawnSync([ps, "-p", String(pid), "-o", "uid="], { stdout: "pipe", stderr: "ignore", timeout: 250 });
    const text = result.stdout.toString().trim();
    return result.exitCode === 0 && /^\d+$/.test(text) ? Number(text) : null;
  } catch { return null; }
}
/** Whether a recorded Orca process could still own this PID. Foreign ownership
 * proves the original agent is gone even when the recycled PID itself exists. */
export function processAlive(pid: number, owner: (pid: number) => number | null = processOwner): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code !== "EPERM") return null;
    // This runner launches agents as the current UID. A denied PID now owned
    // by another UID was recycled; it cannot be the recorded Orca process.
    const uid = process.getuid?.(), observed = owner(pid);
    return uid !== undefined && observed !== null && observed !== uid ? false : null;
  }
}
/** Shared evidence rules for status reporting and dispatch ownership checks. */
export function classifyAgent(agent: string, record: RunState | null, launch: string | undefined, pane: boolean | undefined, available: boolean,
  alive: (pid: number) => boolean | null = processAlive): { status: "running" | "exited" | "unknown"; reason: string } {
  if (!record || typeof record.run !== "string" || !Number.isInteger(record.pid) || record.pid <= 0 || record.role !== agent.split("-")[0] || !["running", "reported"].includes(record.state)) return { status: "unknown", reason: "missing or invalid run record" };
  if (launch !== record.run) return { status: "unknown", reason: "current launch does not match the run record" };
  const pid = alive(record.pid);
  if (pid === false) return { status: "exited", reason: record.endedAt ? "run ended; process is gone" : "process is gone" };
  if (pid === null) return { status: "unknown", reason: "process could not be verified" };
  if (record.endedAt) return { status: "unknown", reason: "run ended but its process is still present" };
  if (!available || pane !== true) return { status: "unknown", reason: "live process has no verified live agent pane" };
  return { status: "running", reason: "current launch, process and live pane agree" };
}
