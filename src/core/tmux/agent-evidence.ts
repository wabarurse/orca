import type { RunState } from "./exits";

export function processAlive(pid: number): boolean | null {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null; }
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
