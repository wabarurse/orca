import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paths } from "../../../config";
import { canonicalTask } from "../../../protocol/task-ledger";
import type { Task } from "../../../protocol/tasks";
import { allTasks, getTask, listTasks, observeTaskPR, prepareTaskRun, registerTask, removeTask, setTaskDependencies, startTaskRun, stopTaskRun, updateTaskMetadata } from "./tasks";
import { searchLedger } from "./ledger-store";
import { purgeProject } from "../memory/archive";
import { backfillMemory } from "../memory/backfill";

const home = mkdtempSync(join(tmpdir(), "persistent-tasks-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
let project: string, n = 0;
beforeEach(() => { project = `p${++n}`; mkdirSync(paths.project(project), { recursive: true }); });
const path = () => join(paths.project(project), "tasks.json");
const create = (name = "first") => registerTask(project, { name, summary: `Summary ${name}`, branch: `feat/${name}`, authorized: true });
const pr = { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", head: "a".repeat(40) };
async function merge(t: Task) { return observeTaskPR(project, t.id, { pr, branch: t.branch, state: "MERGED", mergedAt: "2026-01-03T00:00:00Z", ready: false, checks: "unknown" }); }
function legacy(id: string, createdAt: string): Task {
  return { id, name: "legacy", summary: "Historical", branch: `feat/${id}`, status: "queued", createdAt, updatedAt: createdAt, revision: 1,
    runs: [], history: [{ revision: 1, at: createdAt, kind: "registered", status: "queued" }] };
}

test("deterministic legacy import backs up bytes, preserves UUID/history and merges, never fabricates checkpoints", async () => {
  const a = legacy("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2025-01-01"), b = legacy("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "2025-01-02");
  b.pr = pr; b.archive = { reason: "merged", mergedAt: "2025-01-03", archivedAt: "2025-01-04", pr };
  const bytes = JSON.stringify({ version: 1, tasks: [b, a] }); writeFileSync(path(), bytes);
  const tasks = await allTasks(project);
  expect(tasks.map(t => [t.id, t.number])).toEqual([[a.id, 1], [b.id, 2]]);
  expect(tasks[1]!.history).toEqual(b.history); expect(tasks[1]!.archive).toEqual(b.archive);
  expect(canonicalTask(tasks[1]!).checkpoints).toEqual({ queuedAt: b.createdAt, mergedAt: b.archive.mergedAt });
  expect(await listTasks(project)).toHaveLength(2);
  expect(readFileSync(`${path()}.legacy-v1.backup`, "utf8")).toBe(bytes);
  const view = JSON.parse(readFileSync(path(), "utf8"));
  expect(view.version).toBe(2); expect(view.tasks[0].title).toBe("legacy");
  for (const key of ["runs", "history", "readiness", "branch", "revision"]) expect(view.tasks[0]).not.toHaveProperty(key);
  expect(await allTasks(project)).toEqual(tasks);
  // Simulate crash after SQL migration commit but before projection rename.
  writeFileSync(path(), bytes); expect(await allTasks(project)).toEqual(tasks);
  expect(JSON.parse(readFileSync(path(), "utf8")).version).toBe(2);
});

test("lifecycle evidence automatically sets first checkpoints independent of CI and preserves them across retries", async () => {
  const task = await create(); expect(canonicalTask(task).status).toBe("queued");
  await prepareTaskRun(project, task.id, task.branch, { id: "w", role: "worker", agent: "worker" });
  expect(canonicalTask(await getTask(project, task.id)).checkpoints.buildingAt).toBeUndefined();
  await startTaskRun(project, "w"); const started = canonicalTask(await getTask(project, task.id)); expect(started.status).toBe("building");
  await stopTaskRun(project, "w", "waiting", "done");
  const open = await observeTaskPR(project, task.id, { pr, branch: task.branch, state: "OPEN", ready: false, checks: "failed" });
  expect(canonicalTask(open).status).toBe("pr open"); expect(open.readiness).toBeUndefined();
  const first = canonicalTask(open).checkpoints;
  await observeTaskPR(project, task.id, { pr, branch: task.branch, state: "CLOSED", ready: false, checks: "unknown" });
  await prepareTaskRun(project, task.id, task.branch, { id: "retry", role: "worker", agent: "worker" }); await startTaskRun(project, "retry");
  expect(canonicalTask(await getTask(project, task.id)).checkpoints).toEqual(first);
  const merged = await merge(task); expect(canonicalTask(merged).status).toBe("merged");
  expect(canonicalTask(merged).checkpoints.mergedAt).toBe("2026-01-03T00:00:00Z");
});

test("confirmed merged-only removal retains dependencies, numbers and global memory after project purge", async () => {
  const a = await create(), b = await create("second");
  await expect(removeTask(project, a.id, true)).rejects.toThrow("only merged");
  await merge(a); await expect(removeTask(project, a.id, false)).rejects.toThrow("confirmation");
  const stale = readFileSync(path(), "utf8");
  await removeTask(project, "#1", true);
  expect((await listTasks(project)).map(t => t.number)).toEqual([2]);
  await setTaskDependencies(project, String(b.number), ["#1"]);
  expect((await getTask(project, b.id)).dependsOn).toEqual([a.id]);
  writeFileSync(path(), stale); await allTasks(project);
  expect(JSON.parse(readFileSync(path(), "utf8")).tasks.map((t: { number: number }) => t.number)).toEqual([2]);
  expect((await create("third")).number).toBe(3);
  purgeProject(project); rmSync(paths.project(project), { recursive: true });
  const found = searchLedger({ project, taskId: a.id }) as { task: { id: string }; removedAt: string }[];
  expect(found[0]!.task.id).toBe(a.id); expect(found[0]!.removedAt).toBeTruthy();
  expect(() => readFileSync(path(), "utf8")).toThrow();
});

test("stale/corrupt JSON repairs after SQL commit; old/future writers fail closed", async () => {
  const task = await create(), stale = readFileSync(path(), "utf8");
  await updateTaskMetadata(project, "1", { title: "Changed" });
  for (const bytes of [stale, "{truncated"]) {
    writeFileSync(path(), bytes); expect((await getTask(project, task.id)).name).toBe("Changed");
    expect(JSON.parse(readFileSync(path(), "utf8")).tasks[0].title).toBe("Changed");
  }
  rmSync(path()); expect((await getTask(project, "#1")).name).toBe("Changed");
  for (const version of [1, 99]) {
    writeFileSync(path(), JSON.stringify({ version, tasks: [] }));
    await expect(allTasks(project)).rejects.toThrow();
    expect((searchLedger({ project })[0] as { task: { title: string } }).task.title).toBe("Changed");
  }
});

test("projection rename failure commits SQL exactly once and next read repairs membership", async () => {
  const task = await create(); await merge(task);
  // A directory is readable neither as projection nor as a rename target: commit
  // must remain durable if the projection filesystem becomes unavailable.
  rmSync(path()); mkdirSync(path());
  await expect(removeTask(project, task.id, true)).rejects.toThrow();
  rmSync(path(), { recursive: true });
  expect((await getTask(project, task.id)).removedAt).toBeTruthy();
  expect(await listTasks(project)).toEqual([]);
  const revision = (await getTask(project, task.id)).revision;
  await removeTask(project, task.id, true); expect((await getTask(project, task.id)).revision).toBe(revision);
});

test("concurrent allocation is serialized, same-repository conversation scope remains distinct", async () => {
  const tasks = await Promise.all(Array.from({ length: 8 }, (_, i) => create(`t${i}`)));
  expect(tasks.map(t => t.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const other = `${project}-other`; mkdirSync(paths.project(other), { recursive: true });
  const t = await registerTask(other, { name: "other", summary: "other", branch: "feat/t0", authorized: true });
  expect(t.number).toBe(1); expect(t.id).not.toBe(tasks[0]!.id);
  await expect(setTaskDependencies(project, tasks[0]!.id, [t.id])).rejects.toThrow("not found");
  // Directory recreation may not silently inherit the previous conversation.
  rmSync(paths.project(other), { recursive: true }); mkdirSync(paths.project(other));
  await expect(allTasks(other)).rejects.toThrow("identity/repository changed");
});

test("backfill leaves global ledger intact and refuses deleting per-project durable ledger tables", async () => {
  const task = await create(); await merge(task); await removeTask(project, task.id, true);
  const oldPath = join(paths.project(project), "memory.sqlite"), old = new Database(oldPath);
  old.exec("CREATE TABLE task_ledger_records(id TEXT)"); old.close();
  const logs: string[] = [];
  await backfillMemory({ log: line => logs.push(line) });
  expect(readFileSync(oldPath).length).toBeGreaterThan(0);
  expect(logs.join("\n")).toContain("durable task ledger");
  expect((searchLedger({ project }) as unknown[]).length).toBe(1);
});
