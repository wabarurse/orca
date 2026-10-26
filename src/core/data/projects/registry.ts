// The project registry: orchestrator names (orch-xxxx), display names, the
// bound checkout a project reuses, and the pinned/ordered project list.

import { existsSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { $ } from "bun";
import { loadConfig, paths, saveConfig } from "../../../config";
import { checkoutHere } from "./workspace";
import type { ProjectEntry } from "../../../protocol";

/** A fresh orchestrator name, orch-xxxx, that no project uses yet. */
export function newProjectName(taken: string[], random: () => number = Math.random): string {
  for (;;) {
    const name = `orch-${random().toString(36).slice(2, 6).padEnd(4, "0")}`;
    if (!taken.includes(name)) return name;
  }
}

export const validProjectName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

/** What the TUI calls a project (status line, project list): its /rename name, else its id. */
export async function displayName(project: string): Promise<string> {
  const file = Bun.file(paths.displayName(project));
  const name = (await file.exists()) ? (await file.text()).trim() : "";
  return name || project;
}

/**
 * Give a project a display name. Only the name file changes: the folder, the
 * id, the tmux session and running agents stay as they are, so this is safe
 * at any time. Refused when another project already shows that name.
 */
export async function setDisplayName(project: string, name: string): Promise<string> {
  name = name.trim();
  if (!name || name.length > 40 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name)) throw new Error("names are 1-40 printable characters");
  for (const other of await listProjects()) {
    if (other !== project && (other === name || (await displayName(other)) === name)) throw new Error(`another project is already called ${name}`);
  }
  await Bun.write(paths.displayName(project), name + "\n");
  return name;
}

/** A project's origin URL, or "no remote". */
export async function remoteOf(project: string): Promise<string> {
  const res = await $`git -C ${paths.repo(project)} remote get-url origin`.quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString().trim() : "no remote";
}

/** Original checkout path, even when origin exists; null outside a repository. */
export async function repoHere(cwd = process.cwd()): Promise<string | null> {
  return checkoutHere(cwd);
}

/** Reuse by canonical checkout identity, never by a shared remote URL. */
export async function projectFor(directory: string): Promise<string | null> {
  const source = await checkoutHere(directory);
  if (!source) return null;
  for (const name of await listProjects()) {
    if (existsSync(paths.repo(name)) && realpathSync(paths.repo(name)) === source) return name;
  }
  return null;
}

/** A clone source for people: no scheme, no .git, home as ~. */
export function shortRemote(url: string): string {
  return url.replace(/^[a-z+]+:\/\//, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git$/, "").replace(homedir(), "~");
}

/** Keep unavailable bound checkouts listed so their conversations remain discoverable. */
export async function listProjects(): Promise<string[]> {
  const names = await readdir(paths.project("x").replace(/x$/, "")).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names.sort()) if (existsSync(paths.repository(name)) || existsSync(paths.repo(name))) out.push(name);
  return out;
}

// --- the project list ------------------------------------------------------------

/** Pinned projects first, then the rest, each sorted by label (then id). Pins without a project are dropped. */
export function orderProjects(projects: { name: string; label: string }[], pinned: string[]): ProjectEntry[] {
  const pins = new Set(pinned);
  const byLabel = (a: { name: string; label: string }, b: { name: string; label: string }) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name);
  const sorted = [...new Map(projects.map((p) => [p.name, p])).values()].sort(byLabel);
  return [...sorted.filter((p) => pins.has(p.name)), ...sorted.filter((p) => !pins.has(p.name))].map((p) => ({ ...p, pinned: pins.has(p.name) }));
}

/** Every project for the project list (Ctrl+B, /projects), pinned first, labelled with its display name. */
export async function orderedProjects(): Promise<ProjectEntry[]> {
  const projects = await Promise.all((await listProjects()).map(async (name) => ({ name, label: await displayName(name) })));
  return orderProjects(projects, (await loadConfig()).pinned);
}

/** Pin or unpin a project in config.toml; returns whether it is pinned now. */
export async function togglePin(name: string): Promise<boolean> {
  const { pinned } = await loadConfig();
  const on = !pinned.includes(name);
  await saveConfig({ pinned: on ? [...pinned, name] : pinned.filter((n) => n !== name) });
  return on;
}

