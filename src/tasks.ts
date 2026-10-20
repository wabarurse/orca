// tasks.json is the only state the orchestrator keeps. Everything else (PR,
// CI result, review notes) is looked up from git and gh when needed.

import { mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname } from "node:path";
import { paths } from "./config";

export type TaskStatus = "todo" | "working" | "review" | "done" | "blocked";

export interface Task {
  id: string;
  branch: string;
  status: TaskStatus;
  desc: string;
}

export async function readTasks(project: string): Promise<Task[]> {
  const file = Bun.file(paths.tasks(project));
  if (!(await file.exists())) return [];
  return (await file.json()) as Task[];
}

export async function writeTasks(project: string, tasks: Task[]): Promise<void> {
  const path = paths.tasks(project);
  mkdirSync(dirname(path), { recursive: true });
  // Write to a sibling and rename so a crash never leaves a half-written file.
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, JSON.stringify(tasks, null, 2) + "\n");
  await rename(tmp, path);
}

/** Add a task with the next id (t1, t2, ...) and a branch named from its description. */
export async function addTask(project: string, desc: string): Promise<Task> {
  const tasks = await readTasks(project);
  const id = `t${tasks.length + 1}`;
  const task: Task = { id, branch: `${id}-${slug(desc)}`, status: "todo", desc };
  await writeTasks(project, [...tasks, task]);
  return task;
}

export async function setStatus(project: string, id: string, status: TaskStatus): Promise<Task> {
  const tasks = await readTasks(project);
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`tasks: no task ${id}`);
  task.status = status;
  await writeTasks(project, tasks);
  return task;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-") || "task";
}
