import type { ProcessRecord } from "./store";

export interface Entry { pid: number; group: number; started: number }
const listing = () => {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,pgid=,lstart="], {
    // ps prints start times in its own timezone with no zone named: ask for UTC and read them as UTC, so the
    // comparison never depends on this process's timezone (bun test runs in UTC; a shell usually does not).
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "pipe", timeout: 2000,
  });
  if (result.exitCode !== 0) throw new Error("process inspection failed");
  return result.stdout.toString();
};
/** Every process on the machine with its group and start time; throws when the listing is incomplete. */
export function processTable(read = listing): Entry[] {
  return read().trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    const started = match ? Date.parse(`${match[3]!} UTC`) : NaN;
    if (!match || !Number.isFinite(started)) throw new Error("incomplete process inspection");
    return { pid: Number(match[1]), group: Number(match[2]), started };
  });
}
/** One read-only OS snapshot per recovery/cleanup pass. No signalling based on
 * old PIDs: a recycled PID must never target an unrelated process. */
export function processInspection(read = listing): (p: ProcessRecord) => string | undefined {
  let entries: Entry[] | undefined;
  return p => {
    try {
      entries ??= processTable(read);
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
