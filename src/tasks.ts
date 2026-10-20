// tasks.json is the only state the orchestrator keeps. Everything else (PR,
// CI result, review notes) is looked up from git and gh when needed.

export type TaskStatus = "todo" | "working" | "review" | "done" | "blocked";

export interface Task {
  id: string;
  branch: string;
  status: TaskStatus;
  desc: string;
}

// TODO(PR5): read/write paths.tasks(project), with a small helper to add a
// task and another to update status. Keep it to a JSON array; no extra fields.
export async function readTasks(_project: string): Promise<Task[]> {
  throw new Error("tasks: not implemented");
}

export async function writeTasks(_project: string, _tasks: Task[]): Promise<void> {
  throw new Error("tasks: not implemented");
}
