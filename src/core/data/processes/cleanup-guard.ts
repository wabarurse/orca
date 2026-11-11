import { liveProcess, type ProcessRecord } from "./store";
import { processInspection } from "./inspection";

/** An unknown outcome is not evidence that a command is still running. Cleanup
 * may proceed when its supervisor, command and detached process group are all
 * gone. Keep the saved outcome intact; never replay, signal or deliver events.
 * OS inspection must prove absence; failed inspection and incomplete legacy
 * records stay blocked. A dead group leader alone does not exclude descendants. */
export function processCleanupBlocker(p: ProcessRecord, probe?: (pid: number) => void, inspect = processInspection()): string | undefined {
  if (!liveProcess(p) && (p.state !== "unknown" || p.settledAt)) return;
  const command = `command ${p.id} (${p.owner})`;
  if (p.prWatch) return `${command}: PR watch is still active`;
  if (!probe) { const reason = inspect(p); return reason ? `${command}: ${reason}` : undefined; }
  for (const [kind, pid] of [["supervisor", p.supervisorPid], ["command", p.pid]] as const) {
    if (!Number.isSafeInteger(pid) || pid! <= 0 || pid! > 0x7fffffff) return `${command}: cannot verify ${kind}; missing or invalid PID`;
  }
  for (const [kind, pid] of [["supervisor", p.supervisorPid!], ["command", p.pid!], ["process group", -p.pid!]] as const) {
    try { probe(pid); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") continue;
      return `${command}: cannot inspect ${kind} ${Math.abs(pid)} (${code ?? "unknown error"}); verify it has stopped`;
    }
    return `${command}: ${kind} ${Math.abs(pid)} is still present; stop it or wait for it to finish`;
  }
}
