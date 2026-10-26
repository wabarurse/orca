// /delete: remove a project's state once nothing is running in it.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { loadConfig, paths, saveConfig } from "../../config";
import { describeOwner, lockOwner, tryStorageLock } from "../../core/data";
import { conversationTurnLock, withProjectStateLock } from "../../core/data/projects";
import { validProjectName } from "../../core/data/projects";
import { removeProjectWorktrees } from "../../core/data/projects";
import { purgeProject } from "../../core/data/memory";
import { killProjectSession, liveAgentsOrNull } from "../../core/tmux";
import { stopDaemon } from "../../core/agent-loop/orc";

export interface DeleteOptions {
  /** Live agent windows; defaults to the tmux session's. Tests replace it. */
  live?: (project: string) => Promise<string[] | null>;
  /** Stop the project's orchestrator daemon and wait for it (orchestrator-client.ts stopDaemon); tests replace it. */
  stop?: (project: string) => Promise<void>;
  /** Close the project's idle tmux session; defaults to killProjectSession. Tests replace it. */
  kill?: (project: string) => Promise<void>;
  /** Runs once the checks pass, before anything is removed (the TUI closes the project's page here). */
  beforeRemove?: () => Promise<void> | void;
}

/**
 * Delete project state and clean managed worktrees, preserving an original
 * checkout. Legacy clones retain their old deletion behavior. Refused while agents run. Stops
 * the orchestrator daemon, then drops the project from the pins and closes its tmux session.
 */
export async function deleteProject(name: string, { live = liveAgentsOrNull, stop = stopDaemon, kill = killProjectSession, beforeRemove }: DeleteOptions = {}): Promise<void> {
  if (!validProjectName(name)) throw new Error(`not a project name: ${name}`);
  if (!existsSync(paths.project(name))) throw new Error(`no project named ${name}`);
  // Only this conversation's own turn must be excluded, not the checkout-wide one a
  // sibling conversation (Ctrl+N) holds mid-turn: deletion never touches the shared
  // checkout's files, and the worktrees it unregisters are in this project's own
  // namespace, serialised by git itself like the worker worktree add/remove that
  // already runs during sibling turns without the turn lock.
  const lock = conversationTurnLock(name);
  const release = await tryStorageLock(lock, name);
  if (!release) {
    const owner = await lockOwner(lock);
    throw new Error(owner
      ? `${name} orchestrator is mid-turn in another session (${describeOwner(owner)}); wait for that turn to end, then delete`
      : `${name} turn lock ${lock} is held by an unknown owner; verify no orca process is using ${name}, remove the lock, then delete`);
  }
  try {
    const agents = await live(name);
    if (agents === null) throw new Error("cannot check live agents; project was not deleted");
    if (agents.length) throw new Error(`${name} still has live agents (${agents.join(", ")}); wait for them or stop them first`);
    await stop(name); // the daemon must be gone before its files are, or it writes them back
    await kill(name);
    await withProjectStateLock(name, async () => {
      await removeProjectWorktrees(name);
      await beforeRemove?.();
      await rm(paths.project(name), { recursive: true, force: true });
      // Best effort: the project is already gone, and the backfill's orphan cleanup removes leftovers.
      try { purgeProject(name); } catch { /* rebuildable index */ }
    });
    const { pinned } = await loadConfig();
    if (pinned.includes(name)) await saveConfig({ pinned: pinned.filter((n) => n !== name) });
  } finally { await release(); }
}

