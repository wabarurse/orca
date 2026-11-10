import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../config";
import { readProcess, saveProcess, type ProcessRecord } from "../../core/data/processes";
import { deleteProject } from "./project";

let home: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.ORCA_HOME;
  home = mkdtempSync(join(tmpdir(), "orca-delete-commands-"));
  process.env.ORCA_HOME = home;
  mkdirSync(join(home, "projects", "p", "repo"), { recursive: true });
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});
const record = (pid: number): ProcessRecord => ({
  project: "p", id: crypto.randomUUID(), owner: "worker-test", role: "worker", cwd: home,
  command: "fixture", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  state: "unknown", supervisorPid: pid, pid, reason: "cleanup incomplete; result unknown",
  timeoutMs: 1000, maxBytes: 1000, notify: true, events: [],
});

test("deletion permits stale unknown commands whose supervisor and entire group are gone", async () => {
  const child = Bun.spawn(["sh", "-c", "exit 0"], { detached: true, stdout: "ignore", stderr: "ignore" });
  await child.exited;
  const p = record(child.pid);
  await saveProcess(p);
  const order: string[] = [];
  await deleteProject("p", {
    live: async () => [], stop: async () => { order.push("stop"); }, kill: async () => { order.push("kill"); },
    beforeRemove: async () => {
      // Checking liveness must not rewrite the outcome or queue work for an agent.
      expect(await readProcess("p", p.id)).toEqual(p);
      expect(existsSync(paths.inbox("p"))).toBe(false);
      order.push("remove");
    },
  });
  expect(order).toEqual(["stop", "kill", "remove"]);
  expect(existsSync(join(home, "projects", "p"))).toBe(false);
  expect(existsSync(paths.runtimeProject("p"))).toBe(false);
});

test("a live command blocks deletion without stopping its daemon or changing saved state", async () => {
  const p = record(process.pid);
  await saveProcess(p);
  const calls: string[] = [];
  await expect(deleteProject("p", {
    live: async () => [], stop: async () => { calls.push("stop"); }, kill: async () => { calls.push("kill"); },
    beforeRemove: () => { calls.push("remove"); },
  })).rejects.toThrow(p.id);
  expect(calls).toEqual([]);
  expect(await readProcess("p", p.id)).toEqual(p);
  expect(existsSync(paths.project("p"))).toBe(true);
});

test("surviving descendants block deletion even after the group leader has exited", async () => {
  const ready = join(home, "ready");
  const child = Bun.spawn(["sh", "-c", 'sleep 60 & echo ready > "$1"; wait', "sh", ready], {
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  try {
    for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    child.kill("SIGKILL"); await child.exited;
    const p = record(child.pid); await saveProcess(p);
    const calls: string[] = [];
    await expect(deleteProject("p", {
      live: async () => [], stop: async () => { calls.push("stop"); }, kill: async () => { calls.push("kill"); },
    })).rejects.toThrow("process group");
    expect(calls).toEqual([]);
    expect(existsSync(paths.project("p"))).toBe(true);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    await child.exited;
  }
});
