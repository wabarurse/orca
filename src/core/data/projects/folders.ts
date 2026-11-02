import { existsSync } from "node:fs";
import { join } from "node:path";
import { conversationIds, directoryProject, paths, projectCatalog, readProjectState, syncNamedFolders, type FolderProject } from "../../../config";
import { withStorageLock } from "../storage-lock";

export function withFolderLock<T>(action: () => Promise<T>): Promise<T> {
  return withStorageLock(join(paths.runtime, "project-folders.lock"), action);
}

/** Filesystem view only: UUID/catalog membership owns identity, not readable names. */
export function refreshProjectFolders(): void {
  if (!existsSync(`${paths.projects}/.conversations`)) return;
  const conversations = conversationIds(paths.root);
  const label = (id: string) => ({ id, name: readProjectState<string>(id, "name")?.trim() || id });
  const projects: FolderProject[] = projectCatalog(paths.memory).projects.map(p => ({ id: p.id, name: p.name, directory: p.directory,
    conversations: p.conversations.filter(id => conversations.includes(id) && directoryProject(paths.memory, id)?.id === p.id).map(label) }));
  const unassigned = conversations.filter(id => !projects.some(p => p.conversations.some(c => c.id === id)));
  if (unassigned.length) projects.push({ id: "unassigned", name: "Unassigned", directory: "", conversations: unassigned.map(label) });
  syncNamedFolders(paths.root, projects);
}
