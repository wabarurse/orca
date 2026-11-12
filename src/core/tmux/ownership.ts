// The ownership tree. Everything orca stores hangs off one chain, and deleting a node deletes
// everything under it, never anything above or beside it:
//
//   home                 ~/.orca
//   └─ folder            a directory the user works in (its repository is the user's, never deleted)
//      └─ project        one conversation in that folder: transcripts, tasks, inboxes, settings
//         └─ session     where its work happens: the folder itself, or a worker worktree
//            └─ items    agents, tasks, questions, images (and commands, sandboxes, outputs, caches)
//
// Where each level is recorded:
//   folder   the directory catalog            config/directory-projects.ts (`directories`)
//   project  projects/<id>, .runtime/projects/<id>, pins, the search archive
//   session  the session registry             data/projects/workspace-sessions.ts (`workspaces`)
//   items    files inside the project, with an ownership record naming their session
//
// The code calls a folder a "directory project" and a project a "conversation" in older
// modules; this file is the one place that reads and deletes along the whole chain.
import { existsSync } from "node:fs";
import { lstat, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig, paths, repositoryBinding, saveConfig, siblingWorktreeFolder } from "../../config";
import { describeOwner, lockOwner, tryStorageLock } from "../data";
import { assertWorktree, conversationTurnHeld, conversationTurnLock, directories, displayName, projectIdentity, validProjectName, withProjectStateLock, workspaces } from "../data/projects";
import { listProcesses, processCleanupBlocker } from "../data/processes";
import { purgeProject } from "../data/memory";
import { command } from "../proc";
import { killProjectSession, liveAgentsOrNull } from "./liveness";
import { inspectCheckout } from "./workspace-disposal";

// --- the tree, as data ---------------------------------------------------------

export interface SessionNode {
  path: string;
  /** A worker worktree orca created; false for the folder itself, which is the user's. */
  worktree: boolean;
  branch?: string;
  /** Other projects work in this directory too (only the folder itself is ever shared). */
  shared: boolean;
  /** Work that exists nowhere else: source edits, untracked or unrecognised ignored files. */
  uncommitted?: string;
  /** Why this entry cannot be verified as one of the project's worktrees. Deletion refuses. */
  problem?: string;
  items: Partial<Record<workspaces.Kind, string[]>>;
}
export interface ProjectNode { id: string; name: string; sessions: SessionNode[] }
export interface FolderNode { id: string; name: string; directory: string; projects: ProjectNode[] }

/** One project with its sessions and their items. Reads only. */
export async function projectNode(project: string): Promise<ProjectNode> {
  const identity = projectIdentity(project), mine = (m: { project: string; identity: string }) => m.project === project && m.identity === identity;
  const items = new Map<string, SessionNode["items"]>();
  for (const r of workspaces.resources()) if (mine(r)) for (const owner of r.owners) {
    if (!items.has(owner)) items.set(owner, {});
    (items.get(owner)![r.kind] ??= []).push(r.key);
  }
  const registered = workspaces.list().filter(w => !w.cleanedAt && w.members.some(mine));
  const sessions: SessionNode[] = registered.filter(w => !w.disposable).map(w => ({ path: w.path, worktree: false, shared: w.members.length > 1, items: items.get(w.id) ?? {} }));
  // Worktrees come from disk, not the registry: one that was never registered is still this project's to delete.
  if (repositoryBinding(project)?.branch) for (const root of paths.worktreeRoots(project)) {
    const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) { sessions.push({ path: root, worktree: true, shared: false, items: {}, problem: `worktree folder is not a regular directory; preserved: ${root}` }); continue; }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.name === ".DS_Store" && entry.isFile()) continue; // Finder metadata is not a worktree.
      const known = registered.find(w => w.disposable && w.path === path);
      const node: SessionNode = { path, worktree: true, shared: false, ...(known?.branch ? { branch: known.branch } : {}), items: known ? items.get(known.id) ?? {} : {} };
      if (!entry.isDirectory() || entry.isSymbolicLink()) node.problem = `unexpected file in worktree folder; move it before deleting this conversation: ${path}`;
      else try {
        await assertWorktree(project, path);
        const blocker = (await inspectCheckout(path)).blocker;
        if (blocker) node.uncommitted = blocker;
      } catch (error) { node.problem = `cannot inspect worktree ${path}: ${error instanceof Error ? error.message : error}; conversation and files preserved`; }
      sessions.push(node);
    }
  }
  return { id: project, name: await displayName(project), sessions };
}

/** One folder with its projects. Reads only. */
export async function folderNode(id: string): Promise<FolderNode> {
  const folder = (await directories.directoryProjects()).find(p => p.id === id);
  if (!folder) throw new Error("project folder not found");
  const projects = await Promise.all(folder.conversations.filter(c => existsSync(paths.project(c))).map(projectNode));
  return { id, name: folder.name, directory: folder.directory, projects };
}

/** What deleting these projects removes, for the question put to the user before it happens. */
export function describeDeletion(projects: ProjectNode[]): string {
  const worktrees = projects.flatMap(p => p.sessions.filter(s => s.worktree && !s.problem));
  const uncommitted = worktrees.filter(s => s.uncommitted).length;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [projects.length > 1 ? count(projects.length, "conversation") : "", worktrees.length ? count(worktrees.length, "worktree") : "",
    uncommitted ? `${uncommitted} with uncommitted files that will be lost` : ""].filter(Boolean).join(", ");
}

// --- the cascade ---------------------------------------------------------------

export interface DeleteOptions {
  /** Stop the project's orchestrator daemon and wait for it. The caller supplies it (the daemon client is above this layer). */
  stop: (project: string) => Promise<void>;
  /** Live agent windows; defaults to the tmux session's. Tests replace it. */
  live?: (project: string) => Promise<string[] | null>;
  /** Close the project's idle tmux session; defaults to killProjectSession. Tests replace it. */
  kill?: (project: string) => Promise<void>;
  /** Runs once the checks pass, before the project's own files are removed (the TUI closes its page here). */
  beforeRemove?: (project: string) => Promise<void> | void;
  /** Remove worktrees that hold uncommitted files too. Without it they refuse the deletion; the
   * TUI sets it after telling the user how many there are. Branches and commits always stay. */
  discard?: boolean;
}

/** Everything that refuses a project's deletion, checked before anything is stopped or removed. */
async function assertDeletable(name: string, node: ProjectNode, { live = liveAgentsOrNull, discard }: DeleteOptions): Promise<void> {
  const agents = await live(name);
  if (agents === null) throw new Error("cannot check live agents; project was not deleted");
  if (agents.length) throw new Error(`${name} still has live agents (${agents.join(", ")}); wait for them or stop them first`);
  for (const process of await listProcesses(name)) {
    const blocker = processCleanupBlocker(process);
    if (blocker) throw new Error(`cannot delete conversation: ${blocker}`);
  }
  for (const session of node.sessions) {
    if (session.problem) throw new Error(session.problem);
    if (session.uncommitted && !discard) throw new Error(`worktree has local files or changes (${session.uncommitted}); keep or remove it before deleting this project: ${session.path}`);
  }
}

/** Session level: a worktree goes with everything in it; the folder itself is the user's and only loses this project. */
async function deleteSessions(name: string, node: ProjectNode): Promise<void> {
  const roots = new Set<string>();
  for (const session of node.sessions.filter(s => s.worktree)) {
    await assertWorktree(name, session.path); // Again, now that nothing can be running in it.
    const removed = await command(["git", "worktree", "remove", "--force", "--", session.path], paths.repo(name));
    if (removed.code !== 0) throw new Error(`could not remove worktree: ${removed.err.trim()}`);
    roots.add(dirname(session.path));
  }
  for (const root of paths.worktreeRoots(name)) if (existsSync(root)) roots.add(root);
  for (const root of roots) {
    const metadata = join(root, ".DS_Store");
    const stat = await lstat(metadata).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
    if (stat?.isFile()) await unlink(metadata);
    // The folder older builds made beside the checkout goes with its last namespace; anything still holding files stays.
    if (await rmdir(root).then(() => true, () => false) && siblingWorktreeFolder(dirname(root))) await rmdir(dirname(root)).catch(() => {});
  }
  if (repositoryBinding(name)?.branch && existsSync(paths.repo(name))) await command(["git", "worktree", "prune"], paths.repo(name));
  workspaces.release(name); // Item level: every ownership record of this project.
}

/**
 * Delete one project (a conversation) and everything under it: its worktrees, its items, its
 * transcripts and runtime state, its folder membership and its pin. The folder's directory and
 * the repository's branches are never touched. Refused while an agent or command may be running.
 */
export async function deleteProject(name: string, options: DeleteOptions): Promise<void> {
  if (!validProjectName(name)) throw new Error(`not a project name: ${name}`);
  if (!existsSync(paths.project(name))) throw new Error(`no project named ${name}`);
  const lock = conversationTurnLock(name);
  const release = await tryStorageLock(lock, name);
  if (!release) {
    const owner = await lockOwner(lock);
    throw new Error(owner
      ? `${name} orchestrator is mid-turn in another session (${describeOwner(owner)}); wait for that turn to end, then delete`
      : `${name} turn lock ${lock} is held by an unknown owner; verify no orca process is using ${name}, remove the lock, then delete`);
  }
  try {
    await assertDeletable(name, await projectNode(name), options);
    await options.stop(name); // The daemon must be gone before its files are, or it writes them back.
    await (options.kill ?? killProjectSession)(name);
    await withProjectStateLock(name, async () => {
      const node = await projectNode(name);
      await assertDeletable(name, node, { ...options, live: async () => [] });
      await deleteSessions(name, node);
      await options.beforeRemove?.(name);
      directories.detach(name);
      await rm(paths.runtimeProject(name), { recursive: true, force: true });
      await rm(paths.project(name), { recursive: true, force: true });
      await directories.refreshFolders();
      // Best effort: the project is already gone, and the backfill's orphan cleanup removes leftovers.
      try { purgeProject(name); } catch { /* rebuildable index */ }
    });
    const { pinned } = await loadConfig();
    if (pinned.includes(name)) await saveConfig({ pinned: pinned.filter(n => n !== name) });
  } finally { await release(); }
}

/**
 * Delete a folder: every project in it, then its record. Each project is checked before the
 * first is deleted, so a running agent in one leaves all of them in place. The directory on
 * disk, its repository and its branches stay exactly as they are.
 */
export async function deleteFolder(id: string, options: DeleteOptions): Promise<void> {
  const folder = await folderNode(id);
  for (const project of folder.projects) {
    if (await conversationTurnHeld(project.id)) throw new Error(`${project.name} is mid-turn; wait for that turn to end, then delete`);
    await assertDeletable(project.id, project, options);
  }
  for (const project of folder.projects) await deleteProject(project.id, options);
  directories.removeFolder(id);
  await directories.refreshFolders();
  const { pinned } = await loadConfig();
  if (pinned.includes(id)) await saveConfig({ pinned: pinned.filter(n => n !== id) });
}
