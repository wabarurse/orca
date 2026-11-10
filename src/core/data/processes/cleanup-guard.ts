import { liveProcess, type ProcessRecord } from "./store";

/** An unknown outcome is not evidence that a command is still running. Cleanup
 * may proceed when its supervisor, command and detached process group are all
 * gone. Keep the saved outcome intact; never replay, signal or deliver events.
 * Only ESRCH proves absence: permission errors, PID reuse and incomplete legacy
 * records stay blocked. A dead group leader alone does not exclude descendants. */
export function processCleanupBlocker(p: ProcessRecord, probe: (pid: number) => void = pid => { process.kill(pid, 0); }): string | undefined {
  if (!liveProcess(p) && p.state !== "unknown") return;
  const command = `command ${p.id} (${p.owner})`;
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
