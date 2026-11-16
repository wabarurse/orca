import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breakStaleLock, withCredentialLock } from "./oauth";

const temps: string[] = [];
afterEach(async () => { for (const d of temps.splice(0)) await rm(d, { recursive: true, force: true }); });

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-lock-"));
  temps.push(dir);
  return dir;
}

/** A pid that has certainly exited. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}

async function placeLock(lock: string, pid: number | null): Promise<void> {
  await mkdir(lock, { recursive: true, mode: 0o700 });
  if (pid !== null) await writeFile(join(lock, "pid"), String(pid));
}

test("breakStaleLock removes a lock whose owner pid is dead", async () => {
  const lock = join(await workdir(), "cred.json.lock");
  await placeLock(lock, await deadPid());
  expect(await breakStaleLock(lock)).toBe(true);
  expect(existsSync(lock)).toBe(false);
});

test("breakStaleLock leaves a live owner's lock alone", async () => {
  const lock = join(await workdir(), "cred.json.lock");
  await placeLock(lock, process.pid); // this test process is alive
  expect(await breakStaleLock(lock)).toBe(false);
  expect(existsSync(lock)).toBe(true);
});

test("breakStaleLock leaves a lock with no pid file (mid-acquisition) alone", async () => {
  const lock = join(await workdir(), "cred.json.lock");
  await placeLock(lock, null);
  expect(await breakStaleLock(lock)).toBe(false);
  expect(existsSync(lock)).toBe(true);
});

test("withCredentialLock breaks a stale lock and runs the action", async () => {
  const path = join(await workdir(), "cred.json");
  await placeLock(`${path}.lock`, await deadPid());
  let ran = false;
  const result = await withCredentialLock(path, async () => { ran = true; return 42; });
  expect(ran).toBe(true);
  expect(result).toBe(42);
  expect(existsSync(`${path}.lock`)).toBe(false); // released after the action
});

test("withCredentialLock serializes two callers on the same path", async () => {
  const path = join(await workdir(), "cred.json");
  const order: string[] = [];
  const first = withCredentialLock(path, async () => { order.push("a-start"); await Bun.sleep(30); order.push("a-end"); });
  const second = withCredentialLock(path, async () => { order.push("b"); });
  await Promise.all([first, second]);
  expect(order).toEqual(["a-start", "a-end", "b"]); // b waits for a to release
});
