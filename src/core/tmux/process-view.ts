// What a conversation has running in the background, for the work page's Processes tab: the pull requests the
// daemon's shared watcher is listening to, and the commands agents started (local stacks, long checks). Read-only,
// except the two stops a person asks for there; a stop never restarts, retries or signals anything else, and the
// orchestrator is told who stopped it so it does not start the same thing again by itself.
import { join } from "node:path";
import { observation, put } from "../data/inbox";
import { controlProcess, listProcesses, liveProcess, prWatchEnabled, processDirectory, processOutput, processOwner, readProcess, setPRWatchEnabled, unresolvedProcess, type ProcessRecord } from "../data/processes";
import { allTasks } from "../data/tasks";
import { activePRTask } from "./pr-observations";

/** A watched pull request. `process` is the explicit `watch_pr` registration, null when only its task links it.
 * `state` is what the watcher last recorded (checks, review, mergeable, failing), null before its first look. */
export interface WatchRow {
  repository: string; number: number; url: string; tasks: { number: number | null; name: string; branch: string }[];
  process: string | null; state: Record<string, string> | null;
}
/** A background command and the end of what it has printed. */
export interface CommandRow { record: ProcessRecord; live: boolean; tail: string }
export interface ProcessView { watches: WatchRow[]; commands: CommandRow[] }

const RECENT_MS = 24 * 3_600_000, TAIL_BYTES = 4000, TAIL_LINES = 30;
async function tail(project: string, id: string): Promise<string> {
  const size = Bun.file(join(processDirectory(project, id), "output.txt")).size;
  if (!size) return "";
  const from = Math.max(0, size - TAIL_BYTES), text = (await processOutput(project, id, from, TAIL_BYTES)).content;
  const lines = text.split("\n");
  return (from ? lines.slice(1) : lines).slice(-TAIL_LINES).join("\n").trimEnd(); // a read from the middle starts inside a line
}

/** Watches by PR number; commands live first, then those that ended in the last day, newest first. */
export async function processView(project: string, now = Date.now()): Promise<ProcessView> {
  const records = await listProcesses(project);
  const watches = new Map<string, WatchRow>();
  const watch = (repository: string, number: number) => {
    const key = `${repository}#${number}`;
    if (!watches.has(key)) watches.set(key, { repository, number, url: `https://github.com/${repository}/pull/${number}`, tasks: [], process: null, state: null });
    return watches.get(key)!;
  };
  for (const task of await allTasks(project)) {
    if (task.pr && activePRTask(task) && prWatchEnabled(project, task.pr)) watch(task.pr.repository, task.pr.number).tasks.push({ number: task.number ?? null, name: task.name, branch: task.branch });
  }
  for (const p of records) if (p.prWatch && p.prChecks && liveProcess(p) && prWatchEnabled(project, p.prChecks)) watch(p.prChecks.repository, p.prChecks.number).process = p.id;
  for (const [key, row] of watches) {
    const value = await observation(project, `pr:${key}`).catch(() => undefined);
    if (value && typeof value === "object") row.state = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k, String(v)]));
  }
  const shown = records.filter(p => !p.prWatch && (unresolvedProcess(p) || now - Date.parse(p.updatedAt) < RECENT_MS));
  const commands = await Promise.all(shown.map(async record => ({ record, live: unresolvedProcess(record), tail: await tail(project, record.id).catch(() => "") })));
  commands.sort((a, b) => Number(b.live) - Number(a.live) || b.record.createdAt.localeCompare(a.record.createdAt));
  return { watches: [...watches.values()].sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number), commands };
}

const told = (project: string, text: string) => put(project, "orchestrator", { from: "runtime", text });
/** The user stopped one command from the Processes tab: like Ctrl+C in its terminal, and the orchestrator is told. */
export async function stopCommand(project: string, id: string): Promise<void> {
  const p = await readProcess(project, id);
  if (p.prWatch) throw new Error("that is a PR watch, not a command");
  if (!unresolvedProcess(p)) throw new Error("that command has already ended");
  await controlProcess(project, id, "stop");
  await told(project, `[process-stopped] The user stopped background command ${id} (owner ${processOwner(p)}): ${p.command.replace(/\s+/g, " ").slice(0, 200)}. Nothing was restarted. Do not start it again unless the user asks.`);
}
/** The user stopped listening to one PR: no more notices for it until it is watched again. GitHub is untouched. */
export async function stopWatch(project: string, pr: { repository: string; number: number }): Promise<void> {
  for (const p of await listProcesses(project)) {
    if (p.prWatch && liveProcess(p) && p.prChecks?.repository === pr.repository && p.prChecks.number === pr.number) await controlProcess(project, p.id, "stop");
  }
  setPRWatchEnabled(project, pr, false);
  await told(project, `[pr-watch-stopped] The user stopped the watch on PR ${pr.repository}#${pr.number}. No more notices will arrive for it; process watch_pr starts it again. The PR itself is unchanged.`);
}
