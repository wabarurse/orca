// Tasks live in $ORCA_DATA/tasks/tasks.json (conversation scope): numbered assignments with status, branch, PR link
// and prerequisites. Every change is a locked read-modify-write and a whole-file rename, so agents in other
// processes never lose a change or read half a file.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../../core/conversations";
import { withStorageLock } from "../../core/lock";

export const statuses = ["queued", "working", "waiting", "pr open", "merged", "closed"] as const;
export type TaskStatus = typeof statuses[number];
export type TaskPR = { repo: string; number: number; url: string };
export type Task = {
  number: number;
  id: string;
  name: string;
  summary: string;
  branch: string | null;
  status: TaskStatus;
  pr: TaskPR | null;
  dependsOn: number[];
  created: string;
  updated: string;
  notes: string[];
};

/** Merged and closed tasks are settled: out of the count, the memory section and the open-task lookups. */
export const settled = (task: Task): boolean => task.status === "merged" || task.status === "closed";

export async function readTasks(dir: string): Promise<Task[]> {
  const file = Bun.file(join(dir, "tasks.json"));
  return await file.exists() ? await file.json() as Task[] : [];
}

/** Run `change` on the current list under the folder's lock; a returned list replaces the file. */
export async function changeTasks<T>(dir: string, change: (tasks: Task[]) => Promise<{ tasks: Task[] | null; result: T }>): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withStorageLock(join(dir, "tasks.lock"), async () => {
    const { tasks, result } = await change(await readTasks(dir));
    if (tasks !== null) await writeAtomic(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
    return result;
  });
}

export const openForBranch = (tasks: Task[], branch: string): Task | null => tasks.find(t => t.branch === branch && !settled(t)) ?? null;

export const taskLine = (t: Task): string =>
  `#${t.number} ${t.name} [${t.status}]${t.branch === null ? "" : ` branch ${t.branch}`}${t.pr === null ? "" : ` PR ${t.pr.repo}#${t.pr.number}`}${t.dependsOn.length > 0 ? ` after ${t.dependsOn.map(n => `#${n}`).join(", ")}` : ""}`;

/** True when making `start` depend on `deps` would close a loop of prerequisites. */
export function wouldCycle(tasks: Task[], start: number, deps: number[]): boolean {
  const byNumber = new Map(tasks.map(t => [t.number, t]));
  const seen = new Set<number>();
  const stack = [...deps];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n === start) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(byNumber.get(n)?.dependsOn ?? []));
  }
  return false;
}
