// Cooperative locks for short storage transactions and long-lived turn ownership.
// Never steal a lock on a timer: a slow model/tool is not a dead process. After
// an unclean exit an operator must verify the owner is gone before removal.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function tryStorageLock(path: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true });
  try { await mkdir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try { await writeFile(`${path}/owner.json`, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }) + "\n"); }
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
