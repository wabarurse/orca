// Serialize model/settings commits, context clears, orchestrator inbox publication
// and managed project creation/deletion, across processes.
// Locks live outside projects so deleting/recreating a directory cannot replace its lock.
import { mkdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { paths, repositoryBinding } from "../../../config";
import { lockHeld } from "../storage-lock";

// Separate conversations using one original checkout must never run overlapping turns.
export const projectTurnLock = (project: string) => {
  const binding = repositoryBinding(project);
  return binding
    ? join(paths.runtime, "checkout-locks", createHash("sha256").update(binding.directory).digest("hex"))
    : conversationTurnLock(project);
};
// This conversation's own turn, taken inside the checkout lock (the same path for
// legacy clones). Deletion needs only this one: a sibling mid-turn on the shared
// checkout does not make this conversation busy.
export const conversationTurnLock = (project: string) => join(paths.runtime, "turn-locks", project);
/** The lock paths a turn owns, checkout-wide first; one path for legacy clones. */
export const turnLocks = (project: string): string[] => [...new Set([projectTurnLock(project), conversationTurnLock(project)])];
/** Whether a turn is owned by a process that may still be running (a dead owner's lock does not count). */
export async function turnLocksHeld(project: string): Promise<boolean> {
  for (const path of turnLocks(project)) if (await lockHeld(path)) return true;
  return false;
}

export function projectIdentity(project: string): string {
  const s = statSync(paths.project(project), { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
/** `what` names the interrupted action ("switching model"); the default is neutral, since many saves share this check. */
export function assertProjectIdentity(project: string, identity: string, what = "saving"): void {
  if (projectIdentity(project) !== identity) throw new Error(`project changed while ${what}; try again`);
}
const queues = new Map<string, Promise<unknown>>();
/** Invocation-order queue locally, exclusive directory lock between processes. */
export function withProjectStateLock<T>(project: string, action: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) return Promise.reject(new Error("invalid project id"));
  const key = join(paths.runtime, "project-locks", project);
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => locked(key, action));
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
async function acquire(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  for (let attempt = 0; attempt < 500; attempt++) {
    try { await mkdir(path); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await Bun.sleep(10);
  }
  throw new Error(`project state is locked; try again (if no orca process is active, remove stale lock ${path})`);
}
async function locked<T>(path: string, action: () => Promise<T>): Promise<T> {
  await acquire(path);
  try { return await action(); }
  finally { await rm(path, { recursive: true, force: true }); }
}
