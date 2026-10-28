import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config/config";
import { taskDependencies, taskTreeView, type Task } from "../../../protocol/task/tasks";
import { archiveMergedTasks, getTask, registerTask, setTaskAttention } from "./tasks";

const home = mkdtempSync(join(tmpdir(), "task-tree-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const dep = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const now = "2026-01-01T00:00:00.000Z";
const pr = { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", head: "a".repeat(40) };
const readiness = { head: pr.head, run: "review", validatedAt: now, validation: "review and targeted checks", checks: "passed" as const };
const base = (): Task => ({ id, name: "1/4 tree", summary: "after another task", branch: "feat/tree", status: "queued", createdAt: now, updatedAt: now, revision: 1, runs: [], history: [{ revision: 1, at: now, kind: "registered", status: "queued" }] });

test("tree projection keeps all states, warnings and explicit associated records without mutation or inference", () => {
  for (const status of ["queued", "working", "reviewing"] as const) {
    const task = { ...base(), status, pr, runs: [{ id: "run", agent: "worker", role: "worker" as const, state: "stopped" as const, preparedAt: now, startedAt: now, endedAt: now }] };
    const before = structuredClone(task), view = taskTreeView(task);
    expect(view.state).toEqual({ kind: status, attention: { kind: "none" } });
    expect(view.dependsOn).toEqual([]);
    expect(view.source).toEqual(task);
    view.source.runs[0]!.agent = "changed";
    expect(task).toEqual(before);
    for (const kind of ["waiting", "blocked", "cancelled", "closed", "unknown"] as const) {
      expect(taskTreeView({ ...task, attention: { kind, reason: "needs attention" } }).state.attention).toEqual({ kind, reason: "needs attention" });
    }
  }
  const ready = { ...base(), status: "ready_to_merge" as const, pr, readiness };
  expect(taskTreeView(ready).state).toEqual({ kind: "ready_to_merge", pr, readiness, attention: { kind: "none" } });
  // Durable validation currently forbids this combination; projection must not silently erase a future warning.
  expect(taskTreeView({ ...ready, attention: { kind: "unknown", reason: "stale" } }).state.attention.kind).toBe("unknown");
  expect(() => taskTreeView({ ...ready, readiness: undefined })).toThrow("validation");
  expect(() => taskTreeView({ ...ready, readiness: { ...readiness, head: "b".repeat(40) } })).toThrow("validation");
  const merged = { ...base(), pr, archive: { reason: "merged" as const, pr, mergedAt: now, archivedAt: now } };
  expect(taskTreeView(merged).state).toEqual({ kind: "merged", pr, mergedAt: now, archivedAt: now, attention: { kind: "none" } });
});

test("dependency shape is strict, case-insensitive for identity, and does not guess a registry graph", () => {
  expect(taskDependencies(undefined, id)).toEqual([]);
  expect(taskDependencies([dep], id)).toEqual([dep]);
  for (const bad of [null, dep, [123], ["not-a-uuid"], [id], [id.toUpperCase()], [dep, dep.toUpperCase()]]) {
    expect(() => taskDependencies(bad, id)).toThrow();
  }
});

test("legacy reads do not migrate; dependencies survive updates and archival; malformed records fail closed", async () => {
  const project = "tree-storage";
  mkdirSync(paths.project(project), { recursive: true });
  const task = await registerTask(project, { name: "Tree", summary: "Model", branch: "feat/tree", authorized: true });
  const path = join(paths.project(project), "tasks.json");
  const legacy = readFileSync(path, "utf8");
  expect(taskTreeView(await getTask(project, task.id)).dependsOn).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(legacy);
  const stored = { ...task, dependsOn: [dep], pr };
  writeFileSync(path, JSON.stringify({ version: 1, tasks: [stored] }));
  await setTaskAttention(project, task.id, { kind: "blocked", reason: "waiting for prerequisite" });
  expect((await getTask(project, task.id)).dependsOn).toEqual([dep]);
  await archiveMergedTasks(project, pr, now);
  const archived = await getTask(project, task.id);
  expect(archived.dependsOn).toEqual([dep]);
  expect(archived.history.slice(0, task.history.length)).toEqual(task.history);
  expect(taskTreeView(archived).state.kind).toBe("merged");
  expect(JSON.parse(readFileSync(path, "utf8")).tasks[0].dependsOn).toEqual([dep]);
  for (const dependsOn of [null, [task.id], [dep, dep], ["bad"]]) {
    const bytes = JSON.stringify({ version: 1, tasks: [{ ...stored, dependsOn }] });
    writeFileSync(path, bytes);
    await expect(getTask(project, task.id)).rejects.toThrow();
    await expect(setTaskAttention(project, task.id, { kind: "waiting", reason: "retry" })).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  }
});
