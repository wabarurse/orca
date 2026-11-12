import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config";
import { saveProcess, readProcess, type ProcessRecord } from "./store";
import { makeProcessRoom, pruneSettledProcesses } from "./retention";
import { listProcesses } from "./store";
let root: string, previous: string | undefined;
afterEach(async () => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; if (root) await rm(root, { recursive: true, force: true }); });
test("retention preserves live, unknown and undelivered records while removing old settled logs", async () => {
  previous = process.env.ORCA_HOME; root = await mkdtemp(join(tmpdir(), "orca-process-retention-")); process.env.ORCA_HOME = root;
  await mkdir(paths.project("p"), { recursive: true });
  const record = (state: ProcessRecord["state"], delivered: boolean): ProcessRecord => ({ project: "p", id: crypto.randomUUID(), owner: "worker-x", role: "worker", command: "fixture", cwd: root,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state, timeoutMs: 1000, maxBytes: 4096, notify: true,
    events: [{ event: { id: crypto.randomUUID(), sequence: 1, state, at: "2026-01-01T00:00:00Z" }, text: "fixture", delivered }] });
  const records = [record("exited", true), record("running", true), record("unknown", true), record("failed", false)];
  for (const p of records) await saveProcess(p);
  expect(await pruneSettledProcesses("p")).toHaveLength(1);
  expect((await readProcess("p", records[0]!.id)).state).toBe("exited");
  expect(await pruneSettledProcesses("p", true)).toHaveLength(1);
  await expect(readProcess("p", records[0]!.id)).rejects.toThrow();
  for (const p of records.slice(1)) expect((await readProcess("p", p.id)).state).toBe(p.state);
});

test("a full history makes room from the oldest settled, delivered handles and never from live or undelivered ones", async () => {
  previous = process.env.ORCA_HOME; root = await mkdtemp(join(tmpdir(), "orca-process-room-")); process.env.ORCA_HOME = root;
  await mkdir(paths.project("p"), { recursive: true });
  const record = (state: ProcessRecord["state"], delivered: boolean, at: string): ProcessRecord => ({ project: "p", id: crypto.randomUUID(), owner: "worker-x", role: "worker", command: "fixture", cwd: root,
    createdAt: at, updatedAt: at, state, timeoutMs: 1000, maxBytes: 4096, notify: true, events: [{ event: { id: crypto.randomUUID(), sequence: 1, state, at }, text: "fixture", delivered }] });
  const old = record("exited", true, "2026-01-01T00:00:00Z"), newer = record("exited", true, "2026-01-03T00:00:00Z");
  const kept = [record("running", true, "2026-01-01T00:00:00Z"), record("failed", false, "2026-01-01T00:00:00Z"), record("unknown", true, "2026-01-01T00:00:00Z")];
  for (const p of [old, newer, ...kept]) await saveProcess(p);
  expect(await makeProcessRoom("p", await listProcesses("p"), 6)).toBe(true); // below the cap: nothing is touched
  expect(await listProcesses("p")).toHaveLength(5);
  expect(await makeProcessRoom("p", await listProcesses("p"), 5, 1)).toBe(true); // at the cap: the oldest settled handle goes
  await expect(readProcess("p", old.id)).rejects.toThrow();
  expect((await listProcesses("p")).map(p => p.id).sort()).toEqual([newer, ...kept].map(p => p.id).sort());
  expect(await makeProcessRoom("p", await listProcesses("p"), 3, 1)).toBe(false); // only unsettled or undelivered remain past the cap
  for (const p of kept) expect((await readProcess("p", p.id)).state).toBe(p.state);
});
