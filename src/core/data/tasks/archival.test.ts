import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../../../config";
import { abandonTask, getTask, listTasks, observeTaskPR, prepareTaskRun, registerTask, removeTask, restoreTask, setTaskAttention, startTaskRun, stopTaskRun } from "./tasks";

const home = mkdtempSync(join(tmpdir(), "orca-archive-tasks-"));
process.env.ORCA_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
async function create(project: string) {
  mkdirSync(paths.project(project), { recursive: true });
  const task = await registerTask(project, { name: "Task", summary: "Keep history", branch: "feat/task", authorized: true });
  await abandonTask(project, task.id, task.revision);
  return task;
}

test("an existing v2 ledger gains explicit restore without changing format or accepting stale membership", async () => {
  const project = "old-ledger", t = await create(project);
  await removeTask(project, t.id, true);
  const db = new Database(paths.memory);
  try {
    // Previous binaries return immediately for version 2 and retain the installed trigger.
    db.exec(`DROP TRIGGER task_ledger_revision;
      CREATE TRIGGER task_ledger_revision BEFORE UPDATE ON task_ledger_records
      WHEN NEW.revision<OLD.revision OR NEW.membership_revision<OLD.membership_revision
        OR (OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT OLD.removed_at)
      BEGIN SELECT RAISE(ABORT,'task revision/membership cannot regress'); END;`);
    const restored = await restoreTask(project, t.id);
    expect(restored.removedAt).toBeUndefined(); expect(restored.number).toBe(t.number);
    expect(restored.history.at(-1)?.kind).toBe("membership_restored");
    expect((db.query("SELECT version FROM task_ledger_schema").get() as { version: number }).version).toBe(2);
    expect((await restoreTask(project, t.id)).revision).toBe(restored.revision);
    await removeTask(project, t.id, true);
    const archived = await getTask(project, t.id);
    expect(() => db.query("UPDATE task_ledger_records SET removed_at=NULL WHERE id=?").run(t.id)).toThrow("cannot regress");
    expect(() => db.query("UPDATE task_ledger_records SET removed_at=NULL, revision=revision+1, membership_revision=revision+1 WHERE id=?").run(t.id)).toThrow("cannot regress");
    expect(await getTask(project, t.id)).toEqual(archived);
    expect(await listTasks(project)).toEqual([]);
    expect((await restoreTask(project, t.id)).attention?.kind).toBe("cancelled");
  } finally { db.close(); }
});

test("a new authorized dispatch restores an archived task, but archiving and restore do not start work", async () => {
  const project = "new-dispatch", t = await create(project);
  await removeTask(project, t.id, true);
  expect((await getTask(project, t.id)).runs).toEqual([]);
  await prepareTaskRun(project, t.id, t.branch, { id: "run", agent: "worker-task", role: "worker" });
  expect((await listTasks(project)).map(task => task.id)).toEqual([t.id]);
  const prepared = await getTask(project, t.id);
  expect(prepared.runs[0]!.state).toBe("prepared");
  expect(prepared.history.slice(-2).map(e => e.kind)).toEqual(["membership_restored", "run_prepared"]);
  await startTaskRun(project, "run");
  await expect(removeTask(project, t.id, true)).rejects.toThrow("no active runs");
  await stopTaskRun(project, "run", "cancelled", "User stopped it");
  await removeTask(project, t.id, true); await restoreTask(project, t.id);
  expect((await getTask(project, t.id)).runs[0]!.state).toBe("stopped");
});

test("an open PR cannot be archived even when cancelled; closed PR history survives archive and restore", async () => {
  const project = "pr-state", t = await create(project);
  const pr = { repository: "o/r", number: 1, url: "https://github.com/o/r/pull/1", head: "a".repeat(40) };
  const observation = { pr, branch: t.branch, ready: false, checks: "unknown" as const };
  await observeTaskPR(project, t.id, { ...observation, state: "OPEN" });
  await setTaskAttention(project, t.id, { kind: "cancelled", reason: "No more work" });
  await expect(removeTask(project, t.id, true)).rejects.toThrow("open PR");
  await observeTaskPR(project, t.id, { ...observation, state: "CLOSED" });
  await removeTask(project, t.id, true);
  const restored = await restoreTask(project, t.id);
  expect(restored.pr).toEqual(pr); expect(restored.publication?.state).toBe("CLOSED");
  expect(restored.attention?.kind).toBe("closed");
});
