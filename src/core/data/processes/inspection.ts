import type { ProcessRecord } from "./store";

interface Entry { pid: number; group: number; started: number }
/** One read-only OS snapshot per recovery/cleanup pass. No signalling based on
 * old PIDs: a recycled PID must never target an unrelated process. */
export function processInspection(read = () => {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,lstart="], {
    env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe", timeout: 2000,
  });
  if (result.exitCode !== 0) throw new Error("process inspection failed");
  return result.stdout.toString();
}): (p: ProcessRecord) => string | undefined {
  let entries: Entry[] | undefined;
  return p => {
    try {
      entries ??= read().trim().split("\n").map(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        const started = match ? Date.parse(match[3]!) : NaN;
        if (!match || !Number.isFinite(started)) throw new Error("incomplete process inspection");
        return { pid: Number(match[1]), group: Number(match[2]), started };
      });
    } catch { return "operating-system process inspection unavailable"; }
    const at = Date.parse(p.updatedAt);
    if (!Number.isFinite(at)) return "command has no valid last observation time";
    for (const [kind, pid] of [["supervisor", p.supervisorPid], ["command", p.pid]] as const) {
      if (!Number.isSafeInteger(pid) || pid! <= 0 || pid! > 0x7fffffff) return `cannot verify ${kind}; missing or invalid PID`;
      const found = entries.find(e => e.pid === pid);
      // ps has second precision. Anything started after our final observation
      // cannot be the original process. Older/same-second identities stay held.
      if (found && found.started <= at + 1000) return `${kind} ${pid} is still present`;
    }
    if (entries.some(e => e.group === p.pid)) return `process group ${p.pid} is still present`;
  };
}
