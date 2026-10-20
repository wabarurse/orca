import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, readTasks, setStatus, writeTasks } from "./tasks";

const home = mkdtempSync(join(tmpdir(), "parallels-tasks-"));
process.env.PARALLELS_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));

let n = 0;
let project = "";
beforeEach(() => {
  project = `p${n++}`;
});

test("readTasks on a missing file is empty", async () => {
  expect(await readTasks(project)).toEqual([]);
});

test("addTask numbers ids and slugs the branch", async () => {
  const a = await addTask(project, "Add login page with email + password");
  const b = await addTask(project, "Fix the thing!!!");
  expect(a).toEqual({ id: "t1", branch: "t1-add-login-page-with", status: "todo", desc: "Add login page with email + password" });
  expect(b.id).toBe("t2");
  expect(b.branch).toBe("t2-fix-the-thing");
  expect(await readTasks(project)).toHaveLength(2);
});

test("setStatus updates one task and rejects unknown ids", async () => {
  await addTask(project, "one");
  const t = await setStatus(project, "t1", "review");
  expect(t.status).toBe("review");
  expect((await readTasks(project))[0]?.status).toBe("review");
  expect(setStatus(project, "t9", "done")).rejects.toThrow("no task t9");
});

test("writeTasks leaves no temp file behind", async () => {
  await writeTasks(project, []);
  const { paths } = await import("./config");
  expect(await Bun.file(`${paths.tasks(project)}.tmp`).exists()).toBe(false);
  expect(await Bun.file(paths.tasks(project)).exists()).toBe(true);
});
