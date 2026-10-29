// Agent liveness, read from tmux: which worker/reviewer windows a project's
// session still has, the /agents rows with their latest run's times (and the
// rows the user removed: an archive marker in project state, never the transcript),
// and the daemon's exit-watchdog / merge-watch wrappers over that answer.

import { readdir, stat } from "node:fs/promises";
import { paths, projectStateScope, readProjectState, updateState } from "../../config";
import { existingTasks } from "../data/tasks";
import { readRun, watchdog, type RunState } from "./exits";
import { mergeWatcher } from "./merges";
import { sessionName, tmux } from "./runner";
import type { AgentInfo } from "../../protocol";
import type { Task } from "../../protocol/task";

/** The first transcript entry's ts: read from the file's first line only. */
async function firstEntryTs(path: string): Promise<string | undefined> {
  try {
    const head = await Bun.file(path).slice(0, 8192).text();
    const ts = (JSON.parse(head.split("\n")[0]!) as { ts?: unknown }).ts;
    return typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The latest run's times for agent `name` from its run state (its run file id is its transcript id).
 * A live agent has no end; if its state already has one, that state is a previous run's
 * (a respawn before beginRun) or a run mid-close, so there is no clock. A finished one without endedAt gets the run file's
 * last update, marked approximate; without startedAt, the transcript's first entry.
 */
async function agentTimes(project: string, name: string, live: boolean, state: RunState | null): Promise<Pick<AgentInfo, "startedAt" | "endedAt" | "approximateEnd" | "activity">> {
  if (live && state?.endedAt) return {};
  const startedAt = state?.startedAt ?? (await firstEntryTs(paths.transcript(project, name)));
  if (!startedAt) return {};
  if (live) return { startedAt, ...(state?.step === "waiting for background commands" ? { activity: state.step } : {}) };
  if (state?.endedAt) return { startedAt, endedAt: state.endedAt };
  return state?.ts ? { startedAt, endedAt: state.ts, approximateEnd: true } : { startedAt };
}

/** Project state key of the /agents rows the user removed: agent name → ISO time of removal. */
const ARCHIVED_AGENTS = "archived-agents";
const validAgentName = (name: string) => /^(worker|reviewer)(-[A-Za-z0-9._-]+)?$/.test(name);

/** The removal markers; anything malformed in the record is ignored (the row shows), never trusted. */
function archivedAgents(project: string): Map<string, number> {
  let saved: unknown;
  try { saved = readProjectState(project, ARCHIVED_AGENTS); } catch { return new Map(); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return new Map();
  const out = new Map<string, number>();
  for (const [name, at] of Object.entries(saved)) if (validAgentName(name) && typeof at === "string" && !Number.isNaN(Date.parse(at))) out.set(name, Date.parse(at));
  return out;
}

/** Agents whose latest task (by its newest run naming them) is still open: not merged, removed, closed or cancelled. */
export function openTaskAgents(tasks: Pick<Task, "archive" | "removedAt" | "attention" | "runs">[]): Set<string> {
  const latest = new Map<string, { at: string; open: boolean }>();
  for (const t of tasks) {
    const open = !t.archive && !t.removedAt && t.attention?.kind !== "closed" && t.attention?.kind !== "cancelled";
    for (const r of t.runs) if ((latest.get(r.agent)?.at ?? "") <= r.preparedAt) latest.set(r.agent, { at: r.preparedAt, open });
  }
  return new Set([...latest].filter(([, l]) => l.open).map(([agent]) => agent));
}
/** The task ledger, read-only (no legacy import, no lock); none when unreadable, so no agent is kept for its task. */
const readTasks = (project: string): Task[] => { try { return existingTasks(project); } catch { return []; } };

/** A finished run's end when known (a later write to its transcript, e.g. a migration, is not activity), else the transcript's mtime. */
async function lastActive(path: string, endedAt?: string): Promise<string | undefined> {
  if (endedAt && !Number.isNaN(Date.parse(endedAt))) return endedAt;
  const mtime = await stat(path).then((s) => s.mtimeMs, () => NaN);
  return Number.isNaN(mtime) ? undefined : new Date(mtime).toISOString();
}

const activityMs = (a: AgentInfo) => (a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0) || 0;
/** /agents order: live first, then the latest activity first, then by name. */
export const byActivity = (a: AgentInfo, b: AgentInfo) => Number(b.live) - Number(a.live) || activityMs(b) - activityMs(a) || a.name.localeCompare(b.name);

/**
 * Every agent that has a transcript, marked live when its tmux window is still open, with its latest run's times,
 * its latest activity, whether its task is still open and whether the user removed its row; sorted by byActivity.
 * A removed row comes back when its agent is live or was started again after the removal.
 */
export async function listAgents(project: string): Promise<AgentInfo[]> {
  const live = new Set(await liveAgents(project));
  const dir = paths.transcript(project, "x").replace(/x\.jsonl$/, "");
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).filter((n) => n !== "orchestrator");
  const archived = archivedAgents(project);
  const tasks = openTaskAgents(readTasks(project));
  const agents = await Promise.all(names.map(async (name): Promise<AgentInfo> => {
    const state = await readRun(project, name);
    const times = await agentTimes(project, name, live.has(name), state);
    const lastActiveAt = await lastActive(paths.transcript(project, name), times.endedAt);
    const removedAt = archived.get(name);
    const started = Date.parse(state?.startedAt ?? times.startedAt ?? "");
    const removed = removedAt !== undefined && !live.has(name) && !(started > removedAt);
    return { name, live: live.has(name), ...times, ...(lastActiveAt ? { lastActiveAt } : {}), ...(tasks.has(name) ? { openTask: true } : {}), ...(removed ? { archived: true } : {}) };
  }));
  return agents.sort(byActivity);
}

/**
 * Remove finished agents' rows from /agents: record each name with the time in project state. Transcripts, run files
 * and history stay. Live agents (by tmux, asked now) are refused and returned as `live`; when tmux cannot be asked
 * nothing is removed. Names that are not worker/reviewer agents are ignored.
 */
export async function archiveAgents(project: string, names: string[], live: (project: string) => Promise<string[] | null> = liveAgentsOrNull): Promise<{ archived: string[]; live: string[] }> {
  const running = await live(project);
  if (running === null) throw new Error("could not determine running agents; nothing removed, try again");
  const valid = [...new Set(names)].filter(validAgentName);
  const refused = valid.filter((n) => running.includes(n));
  const archived = valid.filter((n) => !running.includes(n));
  if (!archived.length) return { archived, live: refused };
  const at = new Date().toISOString();
  updateState<Record<string, string>>(paths.memory, projectStateScope(project), ARCHIVED_AGENTS, (old) => {
    const kept = old && typeof old === "object" && !Array.isArray(old) ? Object.fromEntries(Object.entries(old).filter(([n, t]) => validAgentName(n) && typeof t === "string")) : {};
    return { ...kept, ...Object.fromEntries(archived.map((n) => [n, at])) };
  });
  return { archived, live: refused };
}

/** The worker/reviewer windows among a tmux session's windows: all but the idle shell and the orchestrator daemon's. */
export const agentWindows = (windows: string[]) => windows.filter((w) => w !== "shell" && w !== "orchestrator");

/** Agent windows still open in a project's tmux session; read from tmux alone, without transcripts. */
export async function liveAgents(project: string): Promise<string[]> {
  return agentWindows(await tmux.listWindows(sessionName(project)).catch(() => [] as string[]));
}

/** Like liveAgents, but null when tmux could not be asked, so the watchdog never mistakes an error for "all gone". */
export async function liveAgentsOrNull(project: string): Promise<string[] | null> {
  const windows = await tmux.windows(sessionName(project)).catch(() => null);
  return windows && agentWindows(windows);
}

/**
 * The exit watchdog (src/core/tmux/exits.ts), run by the orchestrator daemon on its
 * poll: agents that stopped without reporting or sending their own
 * notice get an `[agent-exit]` notice. `live` is stubbed in tests.
 */
export const exitWatchdog = (live: (project: string) => Promise<string[] | null> = liveAgentsOrNull) => watchdog({ live });

/**
 * The merge watcher (src/core/tmux/merges.ts), run by the orchestrator daemon on its
 * poll next to the exit watchdog; it asks gh about every 30s per project.
 */
export const mergeWatch = (live: (project: string) => Promise<string[] | null> = liveAgentsOrNull) => mergeWatcher({ live });

/** Close a project's (now idle) tmux session, if tmux is installed. */
export async function killProjectSession(project: string): Promise<void> {
  if (Bun.which("tmux")) await tmux.killSession(sessionName(project));
}

