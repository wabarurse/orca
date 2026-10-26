// Agent liveness, read from tmux: which worker/reviewer windows a project's
// session still has, the /agents rows with their latest run's times, and the
// daemon's exit-watchdog / merge-watch wrappers over that answer.

import { readdir } from "node:fs/promises";
import { paths } from "../../config";
import { readRun, watchdog } from "./exits";
import { mergeWatcher } from "./merges";
import { sessionName, tmux } from "./runner";
import type { AgentInfo } from "../../protocol";

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
 * The latest run's times for agent `name` (its run file id is its transcript id).
 * A live agent has no end; if its state already has one, that state is a previous run's
 * (a respawn before beginRun) or a run mid-close, so there is no clock. A finished one without endedAt gets the run file's
 * last update, marked approximate; without startedAt, the transcript's first entry.
 */
async function agentTimes(project: string, name: string, live: boolean): Promise<Pick<AgentInfo, "startedAt" | "endedAt" | "approximateEnd">> {
  const state = await readRun(project, name);
  if (live && state?.endedAt) return {};
  const startedAt = state?.startedAt ?? (await firstEntryTs(paths.transcript(project, name)));
  if (!startedAt) return {};
  if (live) return { startedAt };
  if (state?.endedAt) return { startedAt, endedAt: state.endedAt };
  return state?.ts ? { startedAt, endedAt: state.ts, approximateEnd: true } : { startedAt };
}

/** Every agent that has a transcript, marked live when its tmux window is still open, with its latest run's times. */
export async function listAgents(project: string): Promise<AgentInfo[]> {
  const live = new Set(await liveAgents(project));
  const dir = paths.transcript(project, "x").replace(/x\.jsonl$/, "");
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  return Promise.all(names.filter((n) => n !== "orchestrator").map(async (name) => ({ name, live: live.has(name), ...(await agentTimes(project, name, live.has(name))) })));
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

