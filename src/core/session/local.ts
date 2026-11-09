// Which local project a selector or an incoming bundle means.

import { readFile, stat } from "node:fs/promises";
import { paths } from "../../config";
import { displayName, listProjects, session } from "../data/projects";
import type { BundleManifest } from "./bundle";

/** A session id, a display name or a folder id, in that order. An ambiguous display name is an error, never a guess. */
export async function resolveSelector(selector: string): Promise<string> {
  const projects = await listProjects();
  for (const project of projects) if (session.readSession(project)?.sessionId === selector) return project;
  const named: string[] = [];
  for (const project of projects) if ((await displayName(project)) === selector) named.push(project);
  if (named.length > 1) throw new Error(`"${selector}" names ${named.length} projects (${named.join(", ")}); use a session id or a folder id`);
  if (named[0]) return named[0];
  if (projects.includes(selector)) return selector;
  throw new Error(`no project matches "${selector}" (tried session id, display name, folder id)`);
}

export interface Target {
  /** The local project with this session id. */
  project?: string;
  /** The one local project of this display name that has no session id yet: merged only with --adopt. */
  adoptable?: string;
  /** Local projects of this display name that are other sessions (or several candidates): never merged. */
  collisions: string[];
}

/**
 * The local project an incoming bundle belongs to: the one with its sessionId. Failing that, display names are
 * compared over ALL local projects (never "the last one wins"): a single same-named project that has never been
 * given a sessionId is adoptable (the caller must ask for it); same-named projects of other sessions, or more than
 * one candidate, are collisions. Folder ids are machine-local and never match a bundle.
 */
export async function resolveTarget(manifest: Pick<BundleManifest, "sessionId" | "name">): Promise<Target> {
  const unnamed: string[] = [], other: string[] = [];
  for (const project of await listProjects()) {
    const id = session.readSession(project)?.sessionId;
    if (id === manifest.sessionId) return { project, collisions: [] };
    if ((await displayName(project)) !== manifest.name) continue;
    (id === undefined ? unnamed : other).push(project);
  }
  if (unnamed.length === 1 && !other.length) return { adoptable: unnamed[0], collisions: [] };
  return { collisions: [...unnamed, ...other] };
}

/** Display names and folder ids in use here, optionally ignoring one project. */
export async function takenNames(except?: string): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const project of await listProjects()) {
    if (project === except) continue;
    taken.add(project); taken.add(await displayName(project));
  }
  return taken;
}

export interface SessionRow { name: string; id: string; sessionId: string | null; entries: number; updated: string | null }

/** The projects here as `orca session ls` lists them: display name, folder id, session id (null until first export), orchestrator entries and last write. */
export async function sessionRows(): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  for (const id of await listProjects()) {
    const file = paths.transcript(id, "orchestrator");
    const info = await stat(file).catch(() => null);
    const entries = info ? (await readFile(file, "utf8")).split("\n").filter(Boolean).length : 0;
    rows.push({ name: await displayName(id), id, sessionId: session.readSession(id)?.sessionId ?? null, entries, updated: info ? info.mtime.toISOString() : null });
  }
  return rows;
}
