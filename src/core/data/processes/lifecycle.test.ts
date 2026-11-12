import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLayout, paths } from "../../../config";
import { execution } from "../projects/lifecycle";
import { pending, put } from "../inbox";
import { processTool } from "../../tools/process";
import { cliCommand } from "../../tmux";
import { processInspection } from "./inspection";
import { handoffProcess } from "./handoff";
import { launchProcess } from "./launch";
import { registerPRWatch } from "./pr-watch";
import { controlProcess } from "./supervisor";
import { addProcessEvent, deliverProcessEvents, listProcesses, processDirectory, processOwner, readProcess, recoverableProcesses,
  reconcileProcesses, saveProcess, saveCustody, unresolvedProcess, type ProcessRecord } from "./store";

let root: string, previous: string | undefined;
const project = "lifecycle";
beforeEach(async () => {
  previous = process.env.ORCA_HOME; root = await mkdtemp(join(tmpdir(), "orca-command-lifecycle-")); process.env.ORCA_HOME = root;
  assertLayout(root);
  await mkdir(paths.project(project), { recursive: true });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(root, { recursive: true, force: true });
});
const record = (extra: Partial<ProcessRecord> = {}): ProcessRecord => ({
  project, id: crypto.randomUUID(), owner: "worker-source", role: "worker", command: "unused", cwd: root,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", state: "unknown", pid: 2000000001, supervisorPid: 2000000002,
  timeoutMs: 1000, maxBytes: 4096, notify: true, events: [], reason: "cleanup EPERM; outcome unknown", ...extra,
});
const messages = async (owner: string) => Promise.all((await readdir(join(paths.inbox(project), owner)).catch(() => []))
  .filter(n => n.endsWith(".json")).map(n => Bun.file(join(paths.inbox(project), owner, n)).json()));

test("sixteen legacy unknown records release command slots without changing their outcome or deleting evidence", async () => {
  const old = Array.from({ length: 16 }, () => record());
  for (const p of old) {
    await saveProcess(p); await writeFile(join(processDirectory(project, p.id), "output.txt"), "keep evidence");
    await rm(join(processDirectory(project), "active", p.id)); // old builds excluded delivered unknowns
  }
  await writeFile(join(processDirectory(project), "active", ".initialized"), "1\n");
  const p = record({ state: "starting", pid: undefined, supervisorPid: undefined, reason: undefined,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), command: "printf recovered" });
  await launchProcess(p, cliCommand(), 0);
  for (let i = 0; i < 100 && unresolvedProcess(await readProcess(project, p.id)); i++) await Bun.sleep(30);
  expect((await readProcess(project, p.id)).state).toBe("exited");
  for (const before of old) {
    const after = await readProcess(project, before.id);
    expect(after.state).toBe("unknown"); expect(after.reason).toBe(before.reason); expect(after.settledAt).toBeDefined();
    expect(await Bun.file(join(processDirectory(project, before.id), "output.txt")).text()).toBe("keep evidence");
  }
  await controlProcess(project, old[0]!.id, "stop"); // idempotent, no stale-PID signalling
  await processTool.run({ action: "forget", id: old[0]!.id }, { project, role: "orchestrator", cwd: root });
  await expect(readProcess(project, old[0]!.id)).rejects.toThrow();
});

test("every command gets an evidence folder inside the project's tool outputs", async () => {
  const p = record({ state: "starting", pid: undefined, supervisorPid: undefined, reason: undefined,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), command: 'printf proof > "$ORCA_ARTIFACTS/shot.txt"' });
  await launchProcess(p, cliCommand(), 0);
  for (let i = 0; i < 100 && unresolvedProcess(await readProcess(project, p.id)); i++) await Bun.sleep(30);
  expect(await Bun.file(join(paths.project(project), "tool-outputs", "evidence", "worker-source", "shot.txt")).text()).toBe("proof");
});

test("OS inspection distinguishes PID reuse, surviving descendants and unavailable inspection", () => {
  const p = record({ pid: 102, supervisorPid: 101 });
  let calls = 0;
  const inspect = processInspection(() => { calls++; return "101 101 Wed Nov 11 12:00:00 2026\n1 1 Wed Jan 01 00:00:00 2025\n"; });
  expect(inspect(p)).toBeUndefined(); expect(inspect(p)).toBeUndefined(); expect(calls).toBe(1);
  expect(processInspection(() => "103 102 Wed Jan 01 00:00:00 2025\n")(p)).toContain("process group 102");
  expect(processInspection(() => "101 101 Wed Jan 01 00:00:00 2025\n")(p)).toContain("supervisor 101");
  expect(processInspection(() => { throw Error("denied"); })(p)).toContain("unavailable");
  expect(processInspection(() => "partial table")(p)).toContain("unavailable");
});

test("unknown records with a live original process retain their slot and cannot be forgotten", async () => {
  const p = record({ supervisorPid: process.pid, updatedAt: new Date().toISOString() });
  await saveProcess(p); await reconcileProcesses(project);
  expect((await readProcess(project, p.id)).settledAt).toBeUndefined();
  await expect(processTool.run({ action: "forget", id: p.id }, { project, role: "orchestrator", cwd: root })).rejects.toThrow("settled");
});

test("a running old supervisor cannot hide a later unknown outcome by dropping its marker", async () => {
  const p = record({ state: "running", supervisorPid: process.pid, updatedAt: new Date().toISOString() });
  await saveProcess(p); await recoverableProcesses(project);
  p.state = "unknown"; p.supervisorPid = 2000000002;
  await writeFile(join(processDirectory(project, p.id), "state.json"), JSON.stringify(p));
  await rm(join(processDirectory(project), "active", p.id));
  await reconcileProcesses(project);
  expect((await readProcess(project, p.id)).settledAt).toBeDefined();
});

test("handoff transfers unread and future events; late supervisor writes retain the destination", async () => {
  const p = record({ state: "running", supervisorPid: process.pid, updatedAt: new Date().toISOString() });
  await saveProcess(p); await addProcessEvent(p, "ready");
  await put(project, p.owner, { from: "user", text: "unrelated input stays" });
  const before = structuredClone(p);
  const receipt = await handoffProcess(project, p.id, { actor: p.owner, to: "orchestrator", reason: "Review the result and stop the preview" });
  expect(receipt).toMatchObject({ owner: "orchestrator", restarted: false });
  expect((await messages(p.owner)).map(m => m.text)).toEqual(["unrelated input stays"]);
  expect((await messages("orchestrator")).map(m => m.event.state).sort()).toEqual(["handoff", "ready"]);
  before.state = "exited"; before.exitCode = 0;
  await addProcessEvent(before, "exited"); // original supervisor's stale local snapshot
  const final = await readProcess(project, p.id);
  expect(processOwner(final)).toBe("orchestrator"); expect(final.owner).toBe(p.owner); expect(final.pid).toBe(p.pid);
  expect(final.events.every(e => e.delivered)).toBe(true);
  await deliverProcessEvents(final); await reconcileProcesses(project);
  expect((await messages("orchestrator")).map(m => m.event.state).sort()).toEqual(["exited", "handoff", "ready"]);
  expect((await messages(p.owner))).toHaveLength(1);
});

test("interrupted handoff delivery recovers even while the original supervisor is alive", async () => {
  const p = record({ state: "running", supervisorPid: process.pid, updatedAt: new Date().toISOString() });
  await saveProcess(p); await addProcessEvent(p, "ready");
  await saveCustody(project, p.id, { owner: "orchestrator", from: p.owner, at: new Date().toISOString(), id: crypto.randomUUID(), pending: true, reason: "finish observing" });
  await reconcileProcesses(project); await reconcileProcesses(project);
  expect((await readProcess(project, p.id)).custody?.pending).toBe(false);
  expect(await pending(project, p.owner)).toBe(false);
  expect(await messages("orchestrator")).toHaveLength(2);
});

test("handoff authorization is checked against current custody and never resumes a stopped project", async () => {
  const p = record({ state: "exited" }); await saveProcess(p);
  await mkdir(join(paths.transcript(project, p.owner), ".."), { recursive: true });
  await writeFile(paths.transcript(project, p.owner), "");
  await expect(handoffProcess(project, p.id, { actor: "worker-other", to: "orchestrator", reason: "steal" })).rejects.toThrow("another agent");
  await expect(handoffProcess(project, p.id, { actor: p.owner, to: "worker-missing", reason: "missing" })).rejects.toThrow("does not exist");
  await handoffProcess(project, p.id, { actor: p.owner, to: "orchestrator", reason: "Inspect result" });
  await expect(handoffProcess(project, p.id, { actor: p.owner, to: p.owner, reason: "take back" })).rejects.toThrow("another agent");
  await execution.stop(project);
  await expect(handoffProcess(project, p.id, { actor: "orchestrator", to: p.owner, reason: "continue" })).rejects.toThrow("stopped");
  expect(execution.stopped(project)).toBe(true);
});

test("shared watches consume no command slots and stop permanently with their execution epoch", async () => {
  for (let i = 0; i < 16; i++) await saveProcess(record({ state: "running", supervisorPid: process.pid, updatedAt: new Date().toISOString() }));
  const watch = { repository: "o/r", number: 3, head: "a".repeat(40) };
  const first = await registerPRWatch(project, watch), second = await registerPRWatch(project, { ...watch, head: "b".repeat(40) });
  expect(second).toMatchObject({ process: first.process, reused: true, owner: "orchestrator", commandSlot: false });
  expect((await listProcesses(project)).filter(p => p.prWatch)).toHaveLength(1);
  await execution.stop(project); await reconcileProcesses(project);
  expect((await readProcess(project, first.process)).state).toBe("cancelled");
  execution.resume(project, execution.epoch(project));
  await reconcileProcesses(project);
  expect((await readProcess(project, first.process)).state).toBe("cancelled");
  expect((await recoverableProcesses(project)).some(p => p.id === first.process)).toBe(false);
});

test("completion from an older supervisor is forwarded after it removes the original recovery marker", async () => {
  const p = record({ state: "running", supervisorPid: process.pid, updatedAt: new Date().toISOString() });
  await saveProcess(p);
  await handoffProcess(project, p.id, { actor: p.owner, to: "orchestrator", reason: "Collect the completed test result" });
  const event = { id: crypto.randomUUID(), processId: p.id, sequence: 1, state: "exited", at: new Date().toISOString() };
  const old = { ...p, state: "exited", supervisorPid: 2000000002, events: [{ event, text: "old build completed", delivered: true }] };
  await writeFile(join(processDirectory(project, p.id), "state.json"), JSON.stringify(old));
  await put(project, p.owner, { from: "runtime", text: "old build completed", event });
  await rm(join(processDirectory(project), "active", p.id), { force: true });
  await reconcileProcesses(project); await reconcileProcesses(project);
  expect(await pending(project, p.owner)).toBe(false);
  expect((await messages("orchestrator")).filter(m => m.event.id === event.id)).toHaveLength(1);
  expect((await recoverableProcesses(project)).some(r => r.id === p.id)).toBe(false);
});
