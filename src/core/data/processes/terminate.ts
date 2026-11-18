// Ending a command whose conversation is being deleted, when asking it to stop was not enough: its supervisor
// ignored the stop file (an older build, a hung pipe) or the command ignored the supervisor. Only a process that
// is provably the recorded one is signalled: it must hold the recorded pid (or be in the command's process group)
// and have started no later than the record's last observation, the same rule cleanup uses to call it present.
// A pid the system has since given to another program started later and is never touched.
import { join } from "node:path";
import { withStorageLock } from "../storage-lock";
import { processInspection, processTable, type Entry } from "./inspection";
import { addProcessEvent, liveProcess, processDirectory, readProcess, saveProcess, unresolvedProcess, type ProcessRecord } from "./store";
import { setPRWatchEnabled } from "./pr-watch";

export interface EndOptions { table?: () => Entry[]; inspect?: () => (p: ProcessRecord) => string | undefined; signal?: (pid: number, signal: NodeJS.Signals) => void; waitMs?: number; sleep?: (ms: number) => Promise<void> }

/** The processes that are provably this command's: its supervisor, the command, and the members of its group. */
export function recordedProcesses(p: ProcessRecord, table: Entry[]): number[] {
  const at = Date.parse(p.updatedAt);
  if (!Number.isFinite(at)) return [];
  const own = (e: Entry) => e.started <= at + 1000 && e.pid !== process.pid; // ps has second precision; never ourselves
  return [...new Set(table.filter(e => own(e) && (e.pid === p.supervisorPid || e.pid === p.pid || (p.pid !== undefined && p.pid > 1 && e.group === p.pid))).map(e => e.pid))];
}

/** End one command for good: TERM to what is provably its own, a short wait, then KILL; the record is closed as
 * cancelled. A PR watch is cancelled and unsubscribed. Returns what still blocks cleanup, or undefined. */
export async function endProcess(project: string, id: string, reason: string, options: EndOptions = {}): Promise<string | undefined> {
  const p = await readProcess(project, id);
  if (p.prWatch) {
    if (p.prChecks) setPRWatchEnabled(project, p.prChecks, false);
    if (liveProcess(p)) { p.state = "cancelled"; p.reason = reason; await saveProcess(p); }
    return;
  }
  if (!unresolvedProcess(p)) return;
  const valid = (pid: number | undefined) => Number.isSafeInteger(pid) && pid! > 0 && pid! <= 0x7fffffff;
  // No supervisor or command was ever recorded: its launch never got as far as starting one, so there is nothing to
  // signal and nothing cleanup could ever verify. The record is closed instead of blocking its conversation forever.
  if (!valid(p.supervisorPid) && !valid(p.pid)) return close(project, id, `${reason} (no supervisor was ever recorded)`);
  const table = options.table ?? (() => processTable()), send = options.signal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms)), inspect = options.inspect ?? (() => processInspection());
  const signalAll = (signal: NodeJS.Signals) => {
    for (const pid of recordedProcesses(p, table())) try { send(pid, signal); } catch { /* gone meanwhile */ }
  };
  try { signalAll("SIGTERM"); } catch (error) { return `command ${id}: ${error instanceof Error ? error.message : error}`; }
  const deadline = Date.now() + (options.waitMs ?? 2000);
  while (Date.now() < deadline) { await sleep(100); if (!recordedProcesses(p, table()).length) break; }
  if (recordedProcesses(p, table()).length) { signalAll("SIGKILL"); await sleep(100); }
  const left = inspect()(p);
  if (left) return `command ${id} (${p.owner}): ${left}`;
  return close(project, id, reason);
}
async function close(project: string, id: string, reason: string): Promise<undefined> {
  await withStorageLock(join(processDirectory(project, id), "recovery.lock"), async () => {
    const latest = await readProcess(project, id);
    if (!unresolvedProcess(latest)) return;
    latest.state = "cancelled"; latest.reason = reason; latest.settledAt = new Date().toISOString();
    await addProcessEvent(latest, "cancelled");
  });
  return undefined;
}
