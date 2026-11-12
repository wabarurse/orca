// Directory projects and conversation membership are separate from runtime/storage IDs.
import { validateProjectDirectory } from "./workspace";
import { existsSync } from "node:fs";
import { loadConfig, paths, attachDirectory, detachConversation, removeDirectory, directoryProject, inheritedSettings, projectCatalog, readProjectState, saveOpenConversations, updateDirectory, writeProjectState, type DirectoryProject } from "../../../config";
import { repositoryBinding } from "../../../config";
import { listProjects, displayName, orderedProjects } from "./registry";
import type { ProjectEntry } from "../../../protocol";
import { refreshProjectFolders, withFolderLock } from "./folders";

export function attachConversation(conversation: string): DirectoryProject | undefined {
  const existing = parentProject(conversation);
  if (existing) return existing;
  const binding = repositoryBinding(conversation);
  if (!binding) return;
  const defaults = Object.fromEntries(inheritedSettings.map(key => [key, readProjectState(conversation, key)]).filter(([, value]) => value !== undefined));
  return attachDirectory(paths.memory, conversation, binding.directory, binding.branch, defaults);
}
/** Deleting a conversation removes its membership; deleting a folder removes its (then empty) record. */
export const detach = (conversation: string) => detachConversation(paths.memory, conversation);
export const removeFolder = (id: string) => removeDirectory(paths.memory, id);
export function parentProject(conversation: string): DirectoryProject | undefined {
  return directoryProject(paths.memory, conversation);
}
export async function directoryProjects(): Promise<DirectoryProject[]> {
  for (const conversation of await listProjects()) attachConversation(conversation);
  await refreshFolders();
  return projectCatalog(paths.memory).projects.map(p => ({ ...p, conversations: p.conversations.filter(id => parentProject(id)?.id === p.id) }));
}
export async function projectRows(parent?: string): Promise<ProjectEntry[]> {
  const projects = await directoryProjects();
  if (parent) {
    const project = projects.find(p => p.id === parent);
    if (!project) throw new Error("project not found");
    return Promise.all(project.conversations.filter(id => existsSync(paths.project(id))).map(async id => ({ name: id, label: `${await displayName(id)} (${id})`, pinned: false })));
  }
  const legacy = (await orderedProjects()).filter(row => !projects.some(p => p.conversations.includes(row.name)));
  const pinned = new Set((await loadConfig()).pinned);
  return [...projects.map(p => ({ name: p.id, label: `${p.name} · ${p.conversations.length} conversations${existsSync(p.directory) ? "" : " · directory missing"}`, pinned: pinned.has(p.id) || p.conversations.some(id => pinned.has(id)), directory: p.directory, conversations: p.conversations })), ...legacy].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.label.localeCompare(b.label));
}
export function rememberedConversations(): { open?: string[]; selected?: string } {
  const { open, selected } = projectCatalog(paths.memory); return { open, selected };
}
export function rememberConversations(open: string[], selected?: string): void {
  saveOpenConversations(paths.memory, open, selected);
}
/** Explicitly promote the selected conversation's current preferences to project defaults. */
export function promoteDefaults(conversation: string): void {
  const project = attachConversation(conversation);
  if (!project) throw new Error("conversation has no directory project");
  for (const key of inheritedSettings) writeProjectState(project.id, key, readProjectState(conversation, key));
}
export function inheritDefaults(conversation: string): void {
  if (!parentProject(conversation)) throw new Error("conversation has no directory project");
  for (const key of inheritedSettings) writeProjectState(conversation, key, undefined);
}
export async function refreshFolders(): Promise<void> {
  await withFolderLock(async () => refreshProjectFolders());
}
export async function renameDirectoryProject(id: string, name: string): Promise<void> {
  await withFolderLock(async () => { updateDirectory(paths.memory, id, { name }); refreshProjectFolders(); });
}

/** Relinking changes only metadata. Callers must first exclude active participants. */
export async function relinkDirectoryProject(id: string, source: string): Promise<string> {
  const binding = await validateProjectDirectory(source);
  updateDirectory(paths.memory, id, binding);
  return binding.directory;
}

/** Explicit startup preference only. No conversation is deleted or resumed. Duplicate names retain every match. */
export async function selectStartupConversations(label: string): Promise<string[]> {
  await directoryProjects();
  const known = await listProjects(), selected: string[] = [];
  for (const id of known) if (label === "--all" || id === label || await displayName(id) === label) selected.push(id);
  if (!selected.length) throw new Error(`no conversation named ${label}`);
  rememberConversations(selected, selected.at(-1)); return selected;
}
