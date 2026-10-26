// Cooperative locks for short storage transactions and long-lived turn ownership.
// Never steal a lock on a timer: a slow model/tool is not a dead process. A lock
// is taken over only when its recorded owner pid is verifiably gone (ESRCH); a
// live, unsignalable (EPERM, which includes pid reuse) or unreadable owner keeps
// it, and an operator must verify the owner is gone before removal.
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface LockOwner { pid: number; since: string; project?: string }

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The holder recorded in a lock directory, or undefined when there is none or it is unreadable. */
export async function lockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(`${path}/owner.json`, "utf8"));
    if (typeof owner?.pid !== "number" || typeof owner.since !== "string") return;
    return { pid: owner.pid, since: owner.since, ...(typeof owner.project === "string" ? { project: owner.project } : {}) };
  } catch { return; }
}

/** `pid N since T` plus the owning project when recorded, for refusal messages. */
export const describeOwner = (owner: LockOwner | undefined): string =>
  owner ? `pid ${owner.pid}${owner.project ? ` (${owner.project})` : ""} since ${owner.since}` : "an unknown owner";

export async function tryStorageLock(path: string, project?: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true });
  if (!await createLockDir(path)) return;
  try { await writeFile(`${path}/owner.json`, JSON.stringify({ pid: process.pid, since: new Date().toISOString(), ...(project ? { project } : {}) }) + "\n"); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return async () => {
    try { await rm(path, { recursive: true, force: true }); }
    catch (error) {
      // Work may already be durably committed. Never turn cleanup uncertainty
      // into a failed send/append which a caller might repeat.
      try { console.warn(`storage operation finished, lock cleanup failed (${path}): ${error}`); } catch { /* committed */ }
    }
  };
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Create the lock directory, retrying once after a dead owner's was moved aside; false when it stays held. */
async function createLockDir(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await mkdir(path); return true; }
    catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (attempt || !await takeOverDead(path)) return false;
    }
  }
  return false;
}

/**
 * Move a dead owner's lock directory aside so the caller can create a fresh one.
 * Contenders first claim the directory itself by creating `takeover` inside it,
 * then confirm it still holds the dead owner they read: a fresh directory (owner
 * written or not yet) is never moved, and two contenders cannot both win.
 * True when the caller should retry its mkdir (moved aside, or gone meanwhile).
 */
async function takeOverDead(path: string): Promise<boolean> {
  const claimed = await claimDead(path);
  if (claimed !== "claimed") return claimed === "gone";
  const aside = `${path}.stale-${randomUUID()}`;
  try { await rename(path, aside); }
  catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return true;
  }
  await rm(aside, { recursive: true, force: true }).catch(() => {});
  return true;
}

/** Claim the lock directory for takeover if its recorded owner is dead, confirming it after the claim. */
async function claimDead(path: string): Promise<"claimed" | "held" | "gone"> {
  const dead = await lockOwner(path);
  if (!dead || pidAlive(dead.pid)) return "held";
  const claim = `${path}/takeover`;
  try { await mkdir(claim); }
  catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return "gone"; // Released or taken meanwhile; the caller retries once.
    if (code === "EEXIST") return "held"; // Another taker is at work (or died mid-takeover: operator).
    throw error;
  }
  const now = await lockOwner(path);
  if (now && now.pid === dead.pid && now.since === dead.since && !pidAlive(now.pid)) return "claimed";
  await rmdir(claim).catch(() => {});
  return "held";
}

const queues = new Map<string, Promise<unknown>>();
export function withStorageLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const release = await tryStorageLock(path);
      if (release) { try { return await action(); } finally { await release(); } }
      await Bun.sleep(10);
    }
    throw new Error(`storage is locked; retry (remove ${path} only after verifying no owner is active)`);
  });
  queues.set(path, next);
  void next.finally(() => { if (queues.get(path) === next) queues.delete(path); }).catch(() => {});
  return next;
}
