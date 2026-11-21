import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage, fail, ok, parseJson, type Result } from "../../config";
import { withStorageLock, writeAtomic } from "../../core/plugins";

const StatusSchema = z.enum(["queued", "working", "waiting", "pr open", "merged", "closed"]);
const TaskSchema = z.object({
  number: z.number().int(),
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  branch: z.string().nullable(),
  status: StatusSchema,
  pr: z.object({ repo: z.string(), number: z.number().int(), url: z.string() }).nullable(),
  dependsOn: z.array(z.number().int()),
  created: z.string(),
  updated: z.string(),
  notes: z.array(z.string()),
});
const TasksSchema = z.array(TaskSchema);

export const statuses = StatusSchema.options;
export type TaskStatus = z.infer<typeof StatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskChange<T> = { tasks: Task[] | null; result: T };

export const parseStatus = (value: unknown): TaskStatus | null => {
  const parsed = StatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const settled = (task: Task): boolean => task.status === "merged" || task.status === "closed";

export async function readTasks(dir: string): Promise<Result<Task[]>> {
  const file = Bun.file(join(dir, "tasks.json"));
  if (!await file.exists()) return ok([]);
  const json = parseJson(await file.text());
  if (!json.ok) return fail(`tasks.json is not valid JSON: ${json.error}`);
  const parsed = TasksSchema.safeParse(json.data);
  return parsed.success ? ok(parsed.data) : fail(`tasks.json is not a list of tasks: ${parsed.error.message}`);
}

export async function changeTasks<T>(dir: string, change: (tasks: Task[]) => Promise<TaskChange<T>>): Promise<Result<T>> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return await withStorageLock(join(dir, "tasks.lock"), async (): Promise<Result<T>> => {
      const current = await readTasks(dir);
      if (!current.ok) return current;
      const { tasks, result } = await change(current.data);
      if (tasks !== null) await writeAtomic(join(dir, "tasks.json"), JSON.stringify(tasks, null, 2));
      return ok(result);
    });
  } catch (error) {
    return fail(errorMessage(error));
  }
}

export const openForBranch = (tasks: Task[], branch: string): Task | null => tasks.find(t => t.branch === branch && !settled(t)) ?? null;

export const taskLine = (t: Task): string =>
  `#${t.number} ${t.name} [${t.status}]${t.branch === null ? "" : ` branch ${t.branch}`}${t.pr === null ? "" : ` PR ${t.pr.repo}#${t.pr.number}`}${t.dependsOn.length > 0 ? ` after ${t.dependsOn.map(n => `#${n}`).join(", ")}` : ""}`;

export function wouldCycle(tasks: Task[], start: number, deps: number[]): boolean {
  const byNumber = new Map(tasks.map(t => [t.number, t]));
  const seen = new Set<number>();
  const stack = [...deps];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (n === start) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(byNumber.get(n)?.dependsOn ?? []));
  }
  return false;
}
