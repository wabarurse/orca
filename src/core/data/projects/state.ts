// Serialize model/settings commits, context clears, orchestrator inbox publication
// and managed project creation/deletion, across processes.
// Locks live outside projects so deleting/recreating a directory cannot replace its lock.
import { statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { paths, repositoryBinding } from "../../../config";
import { describeOwner, lockHeld, lockOwner, tryStorageLock } from "../storage-lock";

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
/** How long a project state transaction waits for other holders before it gives up. Holders are brief (ledger and
 * small state files; no network, git, gh or model calls), so this covers a queue of them across processes. */
export const PROJECT_LOCK_WAIT_MS = 30_000;
/** Dependency task actions hold their own lock across git/gh work, which can take minutes on a large repository. */
export const DEPENDENCY_LOCK_WAIT_MS = 300_000;
/** Backoff between attempts: doubling from 10ms to 250ms, plus jitter so contenders do not retry in step. */
export const lockDelay = (attempt: number): number => Math.min(10 * 2 ** attempt, 250) + Math.floor(Math.random() * 10);

const queues = new Map<string, Promise<unknown>>();
const validProject = (project: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project);
/** Invocation-order queue locally, exclusive directory lock between processes. Keep slow work out of `action`:
 * every orca process of the project (agents' run tracking, saves, the inbox) waits on it. */
export function withProjectStateLock<T>(project: string, action: () => Promise<T>): Promise<T> {
  if (!validProject(project)) return Promise.reject(new Error("invalid project id"));
  return serialized(join(paths.runtime, "project-locks", project), project, PROJECT_LOCK_WAIT_MS, "project state", action);
}
/** Serialize a project's dependency task actions (and the run preparation they exclude) across processes. Taken before,
 * never inside, the project state lock; the action takes that lock only briefly for its ledger reads and writes. */
export function withDependencyLock<T>(project: string, action: () => Promise<T>): Promise<T> {
  if (!validProject(project)) return Promise.reject(new Error("invalid project id"));
  return serialized(join(paths.runtime, "dependency-locks", project), project, DEPENDENCY_LOCK_WAIT_MS, "task dependency operation", action);
}
function serialized<T>(key: string, project: string, waitMs: number, what: string, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => locked(key, project, waitMs, what, action));
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
/** The lock records its owner pid; a lock whose owner is verifiably dead is taken over (storage-lock.ts), never one
 * held by a live, unsignalable or unrecorded owner. */
async function acquire(path: string, project: string, waitMs: number, what: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const release = await tryStorageLock(path, project);
    if (release) return release;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await Bun.sleep(Math.min(lockDelay(attempt), left));
  }
  throw new Error(`${what} is locked by ${describeOwner(await lockOwner(path))}; gave up after ${Math.round(waitMs / 1000)}s, try again (remove ${path} only after verifying that owner is gone)`);
}
async function locked<T>(path: string, project: string, waitMs: number, what: string, action: () => Promise<T>): Promise<T> {
  const release = await acquire(path, project, waitMs, what);
  try { return await action(); }
  finally { await release(); }
}
