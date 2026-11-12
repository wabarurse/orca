import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { paths, readState, stateEntries, updateState } from "../../../config";
import { projectIdentity } from "./state";

export const INACTIVE_MS = 14 * 86400_000;
export type Kind = "agent" | "task" | "question" | "image" | "process" | "sandbox" | "artifact" | "cache";
export interface Workspace {
  id: string; path: string; fingerprint: string; disposable: boolean; repo?: string; branch?: string;
  createdAt: string; lastActivityAt: string; archivedAt?: string; cleaning?: boolean; cleanedAt?: string;
  members: { project: string; identity: string }[];
}
export interface Resource {
  project: string; identity: string; kind: Kind; key: string; owners: string[];
  path?: string; fingerprint?: string;
}
const sessions = "workspace-sessions", resourcesScope = "workspace-resources";
const inspection = new AsyncLocalStorage<Map<string, Map<string, unknown>>>();
/** The CLI preview runs discovery/archival against an in-memory overlay; a preview inside a preview shares its overlay. */
export const preview = <T>(action: () => T): T => inspection.getStore() ? action() : inspection.run(new Map(), action);
function read<T>(file: string, area: string, key: string): T | undefined {
  const overlay = inspection.getStore()?.get(area);
  return overlay?.has(key) ? structuredClone(overlay.get(key)) as T | undefined : readState<T>(file, area, key);
}
function entries<T>(file: string, area: string, prefix = ""): [string, T][] {
  const merged = new Map<string, T | undefined>(stateEntries<T>(file, area, prefix));
  for (const [key, value] of inspection.getStore()?.get(area) ?? []) if (key.startsWith(prefix)) merged.set(key, structuredClone(value) as T | undefined);
  return [...merged].filter((row): row is [string, T] => row[1] !== undefined);
}
function write<T>(file: string, area: string, key: string, action: (old: T | undefined) => T | undefined): T | undefined {
  const overlay = inspection.getStore();
  if (!overlay) return updateState(file, area, key, action);
  const next = action(read<T>(file, area, key));
  if (!overlay.has(area)) overlay.set(area, new Map());
  overlay.get(area)!.set(key, structuredClone(next));
  return next;
}
const scope = new AsyncLocalStorage<{ project: string; directory: string }>();
export const fingerprint = (path: string): string => {
  const s = lstatSync(path, { bigint: true });
  if (s.isSymbolicLink()) throw new Error(`workspace ownership path is a symlink: ${path}`);
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
};
function checked(value: Workspace, id: string): Workspace {
  if (!value || value.id !== id || !/^[a-f0-9-]{36}$/.test(id) || !isAbsolute(value.path) || !/^\d+:\d+:\d+$/.test(value.fingerprint)
    || typeof value.disposable !== "boolean" || ![value.createdAt, value.lastActivityAt].every(t => typeof t === "string" && Number.isFinite(Date.parse(t)))
    || !Array.isArray(value.members) || !value.members.length || value.members.some(m => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.project) || typeof m.identity !== "string")
    || (value.disposable && (!value.repo || !isAbsolute(value.repo) || !value.branch))) throw new Error("invalid workspace ownership record; cleanup refused");
  return value;
}
export const get = (id: string) => { const value = read<Workspace>(paths.memory, sessions, id); return value ? checked(value, id) : undefined; };
export const list = () => entries<Workspace>(paths.memory, sessions).map(([id, value]) => checked(value, id));
const resourceKey = (project: string, kind: Kind, key: string) => JSON.stringify([projectIdentity(project), kind, key]);
export const resource = (project: string, kind: Kind, key: string) => read<Resource>(paths.memory, resourcesScope, resourceKey(project, kind, key));
export const resources = (id?: string) => entries<Resource>(paths.memory, resourcesScope).map(([, value]) => value).filter(r => !id || r.owners.includes(id));
/** Read-only preflight for writers already inside their own SQLite transaction. */
export function assertAvailable(project: string, kind: Kind, key: string, directory: string): void {
  const ids = [...(resource(project, kind, key)?.owners ?? [])];
  if (existsSync(directory)) {
    const id = read<string>(paths.memory, "workspace-paths", realpathSync(directory));
    if (id) ids.push(id);
  }
  if (ids.some(id => get(id)?.cleaning)) throw new Error("workspace cleanup is in progress");
}
export function currentDirectory(project: string): string { const current = scope.getStore(); return current?.project === project ? current.directory : paths.repo(project); }
export function within<T>(project: string, directory: string, action: () => T): T { return scope.run({ project, directory }, action); }

/** Paths locate workspaces. Directory identity prevents an old path's resources
 * being inherited by a different checkout; moves retain the stable session ID. */
export function ensure(project: string, directory = currentDirectory(project), options: Partial<Pick<Workspace, "disposable" | "repo" | "branch">> & { at?: string } = {}): Workspace {
  const path = realpathSync(directory), token = fingerprint(path), at = options.at ?? new Date().toISOString();
  const indexed = read<string>(paths.memory, "workspace-paths", path);
  let previous = indexed ? get(indexed) : undefined;
  if (previous?.fingerprint !== token || previous.cleanedAt) previous = list().find(w => w.fingerprint === token && !w.cleanedAt);
  const id = previous?.id ?? crypto.randomUUID(), identity = projectIdentity(project);
  const next = write<Workspace>(paths.memory, sessions, id, old => {
    if (old?.cleaning) throw new Error("workspace cleanup is in progress; retry when it finishes");
    const value: Workspace = old ?? { id, path, fingerprint: token, disposable: options.disposable ?? false, createdAt: at, lastActivityAt: at, members: [] };
    if (value.fingerprint !== token || value.cleanedAt) throw new Error("workspace identity changed");
    value.path = path;
    if (options.disposable !== undefined) value.disposable = options.disposable;
    if (options.repo !== undefined) value.repo = options.repo;
    if (options.branch !== undefined) value.branch = options.branch;
    if (!value.members.some(m => m.project === project && m.identity === identity)) value.members.push({ project, identity });
    if (at > value.lastActivityAt) { value.lastActivityAt = at; delete value.archivedAt; }
    return value;
  })!;
  if (indexed !== id) write<string>(paths.memory, "workspace-paths", path, () => id);
  return next;
}
export function touch(id: string, at = new Date().toISOString()): void {
  write<Workspace>(paths.memory, sessions, id, old => {
    if (!old || old.cleanedAt || old.cleaning) throw new Error("workspace is unavailable during cleanup");
    if (at > old.lastActivityAt) { old.lastActivityAt = at; delete old.archivedAt; }
    return old;
  });
}
/** Called at admission/publication, before launching a process or exposing a
 * new resource. Reading a page or polling status never calls this. */
export function own(project: string, kind: Kind, key: string, options: { directory?: string; path?: string; at?: string; session?: Workspace; exclusive?: boolean } = {}): Workspace | undefined {
  if (!existsSync(paths.project(project))) return;
  let directory = options.directory;
  if (!options.session && !directory) {
    // Legacy image/history storage can outlive a valid checkout binding. Keep
    // those resources unowned (and therefore undeletable), rather than guessing
    // a workspace or making attachment storage depend on repository recovery.
    try { directory = currentDirectory(project); } catch { return; }
  }
  if (!options.session && (!directory || !existsSync(directory))) return;
  const owner = options.session ?? ensure(project, directory, { at: options.at });
  const live = get(owner.id);
  if (!live || live.cleaning || live.cleanedAt) throw new Error("workspace cleanup is in progress");
  const keyInStore = resourceKey(project, kind, key);
  const existing = read<Resource>(paths.memory, resourcesScope, keyInStore);
  if (existing?.owners.includes(owner.id) && (!options.exclusive || existing.owners.length === 1) && !options.path) return owner;
  write<Resource>(paths.memory, resourcesScope, keyInStore, old => {
    const r = old ?? { project, identity: projectIdentity(project), kind, key, owners: [] };
    if (options.exclusive) r.owners = [];
    if (!r.owners.includes(owner.id)) r.owners.push(owner.id);
    if (options.path) { r.path = options.path; try { r.fingerprint = fingerprint(options.path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
    return r;
  });
  return owner;
}
export function archived(project: string, kind: Kind, key: string): string | undefined {
  const r = resource(project, kind, key);
  if (!r?.owners.length) return;
  const owners = r.owners.map(get);
  if (owners.some(o => !o || o.cleanedAt || !o.archivedAt)) return;
  return owners.map(o => o!.archivedAt!).sort().at(-1);
}
export function taskDirectory(project: string, branch: string): string {
  const candidate = paths.worktree(project, branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  return existsSync(candidate) ? candidate : paths.repo(project);
}
export function archivedResources(project: string, kind: Kind): Record<string, boolean> {
  if (!existsSync(paths.project(project))) return {};
  const identity = projectIdentity(project);
  const prefix = JSON.stringify([identity, kind]).slice(0, -1) + ",";
  return Object.fromEntries(entries<Resource>(paths.memory, resourcesScope, prefix).map(([, r]) => r).filter(r => archived(project, kind, r.key)).map(r => [r.key, true]));
}
export function restore(project: string, kind: Kind, key: string): void {
  for (const id of resource(project, kind, key)?.owners ?? []) if (!get(id)?.cleanedAt) touch(id);
}
/** `finished` archives at once: work that is merged or closed and whose checkout is already gone. */
export function archive(id: string, observedActivity: string, now = Date.now(), finished = false): boolean {
  let changed = false;
  write<Workspace>(paths.memory, sessions, id, old => {
    if (old && !old.cleanedAt && !old.cleaning && !old.archivedAt && old.lastActivityAt === observedActivity && (finished || now - Date.parse(old.lastActivityAt) >= INACTIVE_MS)) {
      old.archivedAt = new Date(now).toISOString(); changed = true;
    }
    return old;
  });
  return changed;
}
/** Claim before destructive checks; all new admissions refuse this claim. */
export function claim(id: string, activity: string): void {
  write<Workspace>(paths.memory, sessions, id, old => {
    if (!old?.archivedAt || old.lastActivityAt !== activity || old.cleanedAt) throw new Error("workspace became active; cleanup cancelled");
    old.cleaning = true; return old;
  });
}
export function finish(id: string, complete: boolean): void {
  write<Workspace>(paths.memory, sessions, id, old => {
    if (!old) return old;
    delete old.cleaning;
    if (complete) old.cleanedAt = new Date().toISOString();
    return old;
  });
}
export function forget(id: string, r: Resource): void {
  const key = JSON.stringify([r.identity, r.kind, r.key]);
  write<Resource>(paths.memory, resourcesScope, key, old => {
    if (!old) return;
    old.owners = old.owners.filter(owner => owner !== id);
    return old.owners.length ? old : undefined;
  });
}
