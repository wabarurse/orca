import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorCode } from "./result";

export type LockOwner = { pid: number; since: string; project: string | null };

const OwnerFile = z.object({ pid: z.number(), since: z.string(), project: z.string().optional() });

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

const START_TTL_MS = 30_000, starts = new Map<number, { at: number; started: number | null }>();
function processStart(pid: number, now = Date.now()): number | null {
  const known = starts.get(pid);
  if (known !== undefined && now - known.at < START_TTL_MS) return known.started;
  let started: number | null = null;
  try {
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdout: "pipe", stderr: "ignore" });
    const ms = out.exitCode === 0 ? Date.parse(`${out.stdout.toString().trim()} UTC`) : NaN;
    if (Number.isFinite(ms)) started = ms;
  } catch {}
  if (starts.size > 512) starts.clear();
  starts.set(pid, { at: now, started });
  return started;
}
const START_SLACK_MS = 5000;
export function ownerAlive(owner: { pid: number; since: string }, started: (pid: number) => number | null = processStart): boolean {
  if (!pidAlive(owner.pid)) { starts.delete(owner.pid); return false; }
  const since = Date.parse(owner.since), start = started(owner.pid);
  return start === null || !Number.isFinite(since) || start <= since + START_SLACK_MS;
}

export async function lockOwner(path: string): Promise<LockOwner | null> {
  let text: string;
  try { text = await readFile(`${path}/owner.json`, "utf8"); } catch { return null; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const owner = OwnerFile.safeParse(raw);
  if (!owner.success) return null;
  return { pid: owner.data.pid, since: owner.data.since, project: owner.data.project ?? null };
}

export async function lockHeld(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const owner = await lockOwner(path);
  return owner === null || ownerAlive(owner);
}

export const describeOwner = (owner: LockOwner | null): string =>
  owner !== null ? `pid ${owner.pid}${owner.project !== null ? ` (${owner.project})` : ""} since ${owner.since}` : "an unknown owner";

export async function tryStorageLock(path: string, project: string | null): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(path), { recursive: true });
  if (!await createLockDir(path)) return null;
  try { await writeFile(`${path}/owner.json`, JSON.stringify({ pid: process.pid, since: new Date().toISOString(), ...(project !== null ? { project } : {}) }) + "\n"); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return async () => {
    try { await rm(path, { recursive: true, force: true }); }
    catch (error) {
      try { console.warn(`storage operation finished, lock cleanup failed (${path}): ${String(error)}`); } catch {}
    }
  };
}

async function createLockDir(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await mkdir(path); return true; }
    catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (attempt > 0 || !await takeOverDead(path)) return false;
    }
  }
  return false;
}

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

async function claimDead(path: string): Promise<"claimed" | "held" | "gone"> {
  const dead = await lockOwner(path);
  if (dead === null || ownerAlive(dead)) return "held";
  const claim = `${path}/takeover`;
  try { await mkdir(claim); }
  catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return "gone";
    if (code === "EEXIST") return "held";
    throw error;
  }
  const now = await lockOwner(path);
  if (now !== null && now.pid === dead.pid && now.since === dead.since && !ownerAlive(now)) return "claimed";
  await rmdir(claim).catch(() => {});
  return "held";
}

const queues = new Map<string, Promise<unknown>>();
export function withStorageLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const release = await tryStorageLock(path, null);
      if (release !== null) { try { return await action(); } finally { await release(); } }
      await Bun.sleep(10);
    }
    throw new Error(`storage is locked; retry (remove ${path} only after verifying no owner is active)`);
  });
  queues.set(path, next);
  void next.finally(() => { if (queues.get(path) === next) queues.delete(path); }).catch(() => {});
  return next;
}
