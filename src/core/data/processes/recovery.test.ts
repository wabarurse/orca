import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config";
import { listProcesses, processDirectory, readProcess, recoverableProcesses, reconcileProcesses, saveProcess, type ProcessRecord } from "./store";
const root = mkdtempSync(join(tmpdir(), "orca-recovery-index-"));
process.env.ORCA_HOME = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
function record(project: string, extra: Partial<ProcessRecord> = {}): ProcessRecord {
  mkdirSync(paths.project(project), { recursive: true });
  return { project, id: crypto.randomUUID(), owner: "worker-x", role: "worker", cwd: root, command: "unused",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "exited", timeoutMs: 1000, maxBytes: 1000, notify: true, events: [], ...extra };
}
test("terminal history stays inspectable without recurring recovery locks or record writes", async () => {
  const p = record("terminal"); await saveProcess(p);
  const file = join(processDirectory(p.project, p.id), "state.json"), before = statSync(file).mtimeMs;
  expect(await recoverableProcesses(p.project)).toEqual([]);
  for (let i = 0; i < 4; i++) await reconcileProcesses(p.project);
  expect(await listProcesses(p.project)).toHaveLength(1);
  expect(statSync(file).mtimeMs).toBe(before);
  expect(await Bun.file(join(processDirectory(p.project, p.id), "recovery.lock/owner.json")).exists()).toBe(false);
});
test("undelivered terminal events remain recoverable until delivery is durable", async () => {
  const p = record("outbox", { events: [{ event: { id: crypto.randomUUID(), processId: "test", sequence: 1, state: "exited", at: new Date().toISOString() }, text: "finished" }] });
  await saveProcess(p);
  expect(await recoverableProcesses(p.project)).toHaveLength(1);
  await reconcileProcesses(p.project);
  expect((await readProcess(p.project, p.id)).events[0]!.delivered).toBe(true);
  expect(await recoverableProcesses(p.project)).toEqual([]);
});
test("new commands from older builds are discovered after recovery-index initialization", async () => {
  const p = record("mixed"); await saveProcess(p); await recoverableProcesses(p.project);
  const old = record(p.project, { state: "running", supervisorPid: process.pid });
  mkdirSync(processDirectory(old.project, old.id));
  writeFileSync(join(processDirectory(old.project, old.id), "state.json"), JSON.stringify(old));
  expect((await recoverableProcesses(p.project)).map(p => p.id)).toEqual([old.id]);
});
