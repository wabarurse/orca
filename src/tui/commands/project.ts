// Deleting from the Projects page. The tree and its cascade are core/tmux/ownership.ts; this
// supplies what that layer cannot import: stopping the project's daemon.

import { ownership } from "../../core/tmux";
import { ensureProject, stopDaemon } from "../../core/agent-loop/orc";
import { inheritedSettings, loadConfig, paths, projectStateScope, readState, repositoryBinding, saveConfig, writeProjectState } from "../../config";
import { directories } from "../../core/data/projects";

/** `stop` defaults to the daemon client's `stopDaemon`; tests replace it. */
export type DeleteOptions = Partial<ownership.DeleteOptions>;
const withStop = (options: DeleteOptions): ownership.DeleteOptions => ({ stop: stopDaemon, ...options });

/** Delete one conversation and everything under it (its worktrees, items and state). */
export const deleteProject = (name: string, options: DeleteOptions = {}) => ownership.deleteProject(name, withStop(options));
/** Delete a folder's conversations, then its record. The directory on disk is kept. */
export const deleteFolder = (id: string, options: DeleteOptions = {}) => ownership.deleteFolder(id, withStop(options));
/** What survives a reset: what the user chose for the project, never what happened in it. */
const KEPT = ["name", ...inheritedSettings];
/**
 * /clear-context: the project as if it had just been created. Everything under it goes through
 * the same cascade as a deletion (history, tasks, questions, images, agents, worktrees); then a
 * project with the same id is created in the same folder and gets its name, settings and pin back.
 * Refused, with nothing removed, in every case a deletion is.
 */
export async function resetProject(name: string, options: DeleteOptions = {}): Promise<void> {
  const binding = repositoryBinding(name);
  if (!binding) throw new Error("this project predates folder projects and cannot be reset; delete it and start a new conversation");
  const scope = projectStateScope(name);
  const kept = KEPT.map(key => [key, readState<unknown>(paths.memory, scope, key)] as const).filter(([, value]) => value !== undefined);
  const pinned = (await loadConfig()).pinned.includes(name);
  await ownership.deleteProject(name, withStop(options));
  await ensureProject(name, binding.directory);
  for (const [key, value] of kept) writeProjectState(name, key, value);
  if (pinned) await saveConfig({ pinned: [...new Set([...(await loadConfig()).pinned, name])] });
  await directories.refreshFolders();
}
/** What a deletion will remove, read before asking the user. */
export async function deletionSummary(entry: { name: string; directory?: string }): Promise<string> {
  const projects = entry.directory ? (await ownership.folderNode(entry.name)).projects : [await ownership.projectNode(entry.name)];
  return ownership.describeDeletion(projects);
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
