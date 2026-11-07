import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config";
import { saveProcess, readProcess, type ProcessRecord } from "./store";
import { pruneSettledProcesses } from "./retention";
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
