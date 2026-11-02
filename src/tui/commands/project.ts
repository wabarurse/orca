import { listProcesses, liveProcess } from "../../core/data/processes";
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
    if ((await listProcesses(name)).some(p => liveProcess(p) || p.state === "unknown")) throw new Error("project has active or unresolved commands; reconcile them before deleting");
    await stop(name); // the daemon must be gone before its files are, or it writes them back
    await kill(name);
    await withProjectStateLock(name, async () => {
      await removeProjectWorktrees(name);
      await beforeRemove?.();
      await rm(paths.runtimeProject(name), { recursive: true, force: true });
      await rm(paths.project(name), { recursive: true, force: true });
      // Best effort: the project is already gone, and the backfill's orphan cleanup removes leftovers.
      try { purgeProject(name); } catch { /* rebuildable index */ }
    });
    const { pinned } = await loadConfig();
    if (pinned.includes(name)) await saveConfig({ pinned: pinned.filter((n) => n !== name) });
  } finally { await release(); }
}


/** Explicit relink of a missing/moved directory; the project UUID and conversations remain. */
export async function relinkProjectDirectory(conversation: string, directory: string): Promise<string> {
  const { directories } = await import("../../core/data/projects");
  const project = directories.parentProject(conversation);
  if (!project) throw new Error("conversation has no directory project");
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const id of [...project.conversations].sort()) {
      const release = await tryStorageLock(conversationTurnLock(id), id);
      if (!release) throw new Error("a conversation is running; stop it before relinking");
      releases.push(release);
      const agents = await liveAgentsOrNull(id);
      if (agents === null || agents.length) throw new Error("stop active agents before relinking the project");
      if ((await listProcesses(id)).some(p => liveProcess(p) || p.state === "unknown")) throw new Error("stop or reconcile background commands before relinking");
    }
    const canonical = await directories.relinkDirectoryProject(project.id, directory);
    return `project relinked to ${canonical}; conversations and workspaces preserved`;
  } finally { for (const release of releases.reverse()) await release(); }
}

/** Restoration opens saved views only; it never starts a runtime or submits input. */
export async function restoreConversations(options: {
  project?: string; directory?: string; source?: string | null;
  open: (id: string, directory?: string) => Promise<unknown>; note: (text: string) => void;
}): Promise<void> {
  const { directories, listProjects, projectFor } = await import("../../core/data/projects");
  if (options.project) { await options.open(options.project, options.directory); return; }
  await directories.directoryProjects();
  const known = await listProjects(), saved = directories.rememberedConversations();
  for (const id of (saved.open ?? known).filter(id => known.includes(id))) {
    try { await options.open(id); }
    catch (error) { options.note(`could not open ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (saved.selected && known.includes(saved.selected)) await options.open(saved.selected);
  if (options.source) {
    const existing = await projectFor(options.source, saved.selected);
    if (existing) await options.open(existing);
    else options.note(`new directory: /new <conversation name> ${options.source} to add it as a project`);
  } else if (!known.length) options.note("/new <conversation name> <directory> to add a project");
}

export async function directoryProjectCommand(conversation: string, args: string): Promise<string> {
  const { directories } = await import("../../core/data/projects");
  const project = directories.attachConversation(conversation);
  if (!project) return "conversation is not attached to a directory project";
  if (args.startsWith("rename ")) directories.renameDirectoryProject(project.id, args.slice(7));
  else if (args.startsWith("relink ")) return relinkProjectDirectory(conversation, args.slice(7));
  else if (args) return "usage: /project [rename <name>|relink <directory>]";
  return `${project.name} · ${project.id} · ${project.directory}`;
}
export async function directoryDefaultsCommand(conversation: string, args: string): Promise<string> {
  const { directories } = await import("../../core/data/projects");
  if (args === "inherit") directories.inheritDefaults(conversation);
  else if (!args || args === "save") directories.promoteDefaults(conversation);
  else return "usage: /project-defaults [save|inherit]";
  return args === "inherit" ? "conversation inherits project defaults" : "current settings saved as directory project defaults";
}

/** Project groups reflect their open conversations without reading state during paint. */
export function projectMenu(list: { items: import("../../protocol").ProjectEntry[]; index: number; status: string; parent?: string }, pages: { project: string; busy: boolean }[], selected?: string) {
  const items = list.items.map(it => {
    const members = new Set([it.name, ...(it.conversations ?? [])]), open = pages.filter(page => members.has(page.project));
    return { ...it, open: !!open.length, active: !!selected && members.has(selected), busy: open.some(p => p.busy) };
  });
  const hint = list.parent ? "↑↓ enter opens  n new conversation  d deletes  esc projects" : items.some(it => it.directory) ? "↑↓ enter conversations  p pins  esc closes" : undefined;
  return { items, index: list.index, status: list.status, hint };
}
