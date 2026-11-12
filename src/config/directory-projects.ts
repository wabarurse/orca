import { basename, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { conversationIdentity } from "./conversation-identity";
import { readState, updateState } from "./state-store";
export const inheritedSettings = ["model", "account", "provider-models", "role-models", "model-settings"] as const;
export interface DirectoryProject { id: string; name: string; directory: string; branch: string; conversations: string[]; incarnations: Record<string, string>; defaults: Record<string, unknown>; previousDirectories?: { directory: string; branch: string }[] }
interface Catalog { version: 1; projects: DirectoryProject[]; open?: string[]; selected?: string }
const scope = "directory-projects", key = "catalog";
const empty = (): Catalog => ({ version: 1, projects: [] });
export function projectCatalog(file: string): Catalog {
  const value = readState<Catalog>(file, scope, key) ?? empty();
  if (value.version !== 1 || !Array.isArray(value.projects)) throw new Error("invalid directory project catalog");
  const ids = new Set<string>(), members = new Set<string>();
  for (const p of value.projects) {
    if (!/^[a-f0-9-]{36}$/.test(p.id) || ids.has(p.id) || typeof p.name !== "string" || !p.directory?.startsWith("/") || typeof p.branch !== "string" || !Array.isArray(p.conversations) || !p.incarnations || typeof p.incarnations !== "object" || !p.defaults || typeof p.defaults !== "object") throw new Error("invalid directory project");
    if (p.previousDirectories !== undefined && (!Array.isArray(p.previousDirectories) || p.previousDirectories.some(route => !route || typeof route.directory !== "string" || !route.directory.startsWith("/") || typeof route.branch !== "string"))) throw new Error("invalid project relink history");
    ids.add(p.id);
    for (const member of p.conversations) { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member) || members.has(member)) throw new Error("duplicate conversation membership"); members.add(member); }
  }
  return value;
}
export function directoryProject(file: string, id: string): DirectoryProject | undefined {
  const projects = projectCatalog(file).projects;
  const parent = projects.find(p => p.id === id);
  if (parent) return parent;
  let identity: string;
  try { identity = conversationIdentity(dirname(file), id).id; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  return projects.find(p => p.conversations.includes(id) && p.incarnations[id] === identity);
}
export function attachDirectory(file: string, conversation: string, directory: string, branch: string, defaults: Record<string, unknown>): DirectoryProject {
  const canonical = (() => { try { return realpathSync.native(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return resolve(directory); } })();
  const identity = conversationIdentity(dirname(file), conversation).id;
  let result!: DirectoryProject;
  updateState<Catalog>(file, scope, key, old => {
    const value = old ?? empty();
    const existing = value.projects.find(p => p.conversations.includes(conversation) && p.incarnations[conversation] === identity);
    if (existing) { result = existing; return value; }
    for (const p of value.projects) {
      p.conversations = p.conversations.filter(id => id !== conversation);
      delete p.incarnations[conversation];
    }
    result = value.projects.find(p => p.directory === canonical)!;
    if (!result) { result = { id: crypto.randomUUID(), name: basename(canonical), directory: canonical, branch, conversations: [], incarnations: {}, defaults }; value.projects.push(result); }
    result.conversations.push(conversation); result.incarnations[conversation] = identity;
    return value;
  });
  return result;
}
export function setDirectorySetting(file: string, id: string, setting: string, value: unknown): void {
  updateState<Catalog>(file, scope, key, old => {
    const project = old?.projects.find(p => p.id === id);
    if (!project) throw new Error("directory project not found");
    if (!inheritedSettings.includes(setting as typeof inheritedSettings[number])) throw new Error("not a directory default");
    if (value === undefined) delete project.defaults[setting]; else project.defaults[setting] = value;
    return old;
  });
}
export function updateDirectory(file: string, id: string, patch: { name?: string; directory?: string; branch?: string }): void {
  updateState<Catalog>(file, scope, key, old => {
    const p = old?.projects.find(p => p.id === id);
    if (!p) throw new Error("directory project not found");
    const previous = { directory: p.directory, branch: p.branch };
    if (patch.name !== undefined) { if (!patch.name.trim() || patch.name.length > 80 || /[\x00-\x1f\x7f]/.test(patch.name)) throw new Error("invalid project name"); p.name = patch.name.trim(); }
    if (patch.directory !== undefined) {
      const directory = realpathSync(resolve(patch.directory));
      if (old!.projects.some(other => other.id !== id && other.directory === directory)) throw new Error("directory already belongs to another project");
      p.directory = directory;
    }
    if (patch.branch !== undefined) p.branch = patch.branch;
    if (previous.directory !== p.directory || previous.branch !== p.branch) {
      p.previousDirectories ??= [];
      if (!p.previousDirectories.some(route => route.directory === previous.directory && route.branch === previous.branch)) p.previousDirectories.push(previous);
    }
    return old;
  });
}
/** A deleted conversation leaves its folder; the folder itself stays so a new conversation can start there. */
export function detachConversation(file: string, conversation: string): void {
  updateState<Catalog>(file, scope, key, old => {
    if (!old) return old;
    for (const p of old.projects) { p.conversations = p.conversations.filter(id => id !== conversation); delete p.incarnations[conversation]; }
    if (old.open) old.open = old.open.filter(id => id !== conversation);
    if (old.selected === conversation) delete old.selected;
    return old;
  });
}
/** Only an empty folder record can go: its conversations are deleted first, one by one. */
export function removeDirectory(file: string, id: string): void {
  updateState<Catalog>(file, scope, key, old => {
    const project = old?.projects.find(p => p.id === id);
    if (!project) return old;
    if (project.conversations.length) throw new Error("project still has conversations");
    old!.projects = old!.projects.filter(p => p.id !== id);
    return old;
  });
}
export function saveOpenConversations(file: string, open: string[], selected?: string): void {
  updateState<Catalog>(file, scope, key, old => ({ ...(old ?? empty()), open: [...new Set(open)], selected }));
}
