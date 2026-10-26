import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockOwner, pidAlive, tryStorageLock } from "./storage-lock";

const home = mkdtempSync(join(tmpdir(), "storage-lock-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}
const plant = (path: string, owner: unknown) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owner.json"), JSON.stringify(owner) + "\n");
};

test("a dead owner's lock is taken over, its stale directory removed, and the new owner recorded", async () => {
  const path = join(home, "dead");
  const pid = await deadPid();
  expect(pidAlive(pid)).toBe(false);
  plant(path, { pid, since: "2024-01-01T00:00:00.000Z" });
  const release = await tryStorageLock(path, "proj");
  expect(release).toBeDefined();
  expect(await lockOwner(path)).toEqual({ pid: process.pid, since: expect.any(String), project: "proj" });
  expect(readdirSync(home).filter(n => n.startsWith("dead"))).toEqual(["dead"]);
  await release!();
  expect(existsSync(path)).toBe(false);
});

test("a live owner, an unreadable owner and a lock without metadata are never taken over", async () => {
  const live = join(home, "live");
  plant(live, { pid: process.pid, since: new Date().toISOString() });
  expect(await tryStorageLock(live)).toBeUndefined();
  expect((await lockOwner(live))?.pid).toBe(process.pid);
  const garbled = join(home, "garbled");
  plant(garbled, "not an owner");
  expect(await tryStorageLock(garbled)).toBeUndefined();
  const bare = join(home, "bare");
  mkdirSync(bare);
  expect(await tryStorageLock(bare)).toBeUndefined();
  expect(await lockOwner(bare)).toBeUndefined();
  expect(existsSync(garbled) && existsSync(bare) && existsSync(live)).toBe(true);
});

test("two contenders for a dead owner's lock cannot both win", async () => {
  const path = join(home, "contested");
  let pid = await deadPid();
  for (let round = 0; round < 20; round++) {
    if (pidAlive(pid)) pid = await deadPid(); // The pid was reused meanwhile.
    plant(path, { pid, since: "2024-01-01T00:00:00.000Z" });
    const results = await Promise.all(Array.from({ length: 6 }, () => tryStorageLock(path)));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect((await lockOwner(path))?.pid).toBe(process.pid);
    expect(await tryStorageLock(path)).toBeUndefined();
    await winners[0]!();
    expect(existsSync(path)).toBe(false);
  }
  // Moving the stale directory aside is what matters; its removal is best effort.
  for (let wait = 0; readdirSync(home).some(n => n.startsWith("contested")) && wait < 50; wait++) await Bun.sleep(10);
  expect(readdirSync(home).filter(n => n.startsWith("contested"))).toEqual([]);
});

test("owner metadata is pid and time, plus the project when given", async () => {
  const path = join(home, "owner");
  const release = await tryStorageLock(path);
  expect(await lockOwner(path)).toEqual({ pid: process.pid, since: expect.any(String) });
  await release!();
});
