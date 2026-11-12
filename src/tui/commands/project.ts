import { listProcesses, processCleanupBlocker } from "../../core/data/processes";
// /delete: remove a project's state once nothing is running in it.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { loadConfig, paths, saveConfig } from "../../config";
import { describeOwner, lockOwner, tryStorageLock } from "../../core/data";
import { directories, conversationTurnLock, withProjectStateLock } from "../../core/data/projects";
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
  // Deletion owns only this conversation and its managed worktrees.
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
    for (const command of await listProcesses(name)) {
      const blocker = processCleanupBlocker(command);
      if (blocker) throw new Error(`cannot delete conversation: ${blocker}`);
    }
    await removeProjectWorktrees(name, { dryRun: true });
    await stop(name); // the daemon must be gone before its files are, or it writes them back
    await kill(name);
    await withProjectStateLock(name, async () => {
      await removeProjectWorktrees(name);
      await beforeRemove?.();
      await rm(paths.runtimeProject(name), { recursive: true, force: true });
      await rm(paths.project(name), { recursive: true, force: true });
      await directories.refreshFolders();
      // Best effort: the project is already gone, and the backfill's orphan cleanup removes leftovers.
      try { purgeProject(name); } catch { /* rebuildable index */ }
    });
    const { pinned } = await loadConfig();
    if (pinned.includes(name)) await saveConfig({ pinned: pinned.filter((n) => n !== name) });
  } finally { await release(); }
}

/** Open this checkout's conversations, creating its first when needed. Opening
 * does not submit input or start model work. */
export async function restoreConversations(options: {
  project?: string; directory?: string; source?: string | null;
  open: (id: string, directory?: string) => Promise<unknown>; note: (text: string) => void;
}): Promise<void> {
  const { directories, displayName, listProjects, newProjectName, projectFor } = await import("../../core/data/projects");
  if (options.project) { await options.open(options.project, options.directory); return; }
  await directories.directoryProjects();
  const known = await listProjects(), saved = directories.rememberedConversations();
  const existing = options.source ? await projectFor(options.source, saved.selected) : null;
  if (options.source && !existing) {
    const names = await Promise.all(known.map(displayName));
    await options.open(newProjectName([...known, ...names]), options.source);
    return;
  }
  const group = existing ? directories.parentProject(existing) : undefined;
  // A launch checkout scopes startup even before it has any conversations.
  const matching = group?.conversations ?? (existing ? [existing] : []);
  const opening = options.source ? matching : saved.open ?? known;
  for (const id of opening.filter(id => known.includes(id))) {
    try { await options.open(id); }
    catch (error) { options.note(`could not open ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const selected = saved.selected && opening.includes(saved.selected) ? saved.selected : existing;
  if (selected && known.includes(selected)) await options.open(selected);
  if (!options.source && !known.length) options.note("no projects yet: run orca inside a repository to add one");
}
