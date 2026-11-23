import type { BackgroundContext, Retention, SettledItem } from "../../core/plugins";
import { changeTasks, readTasks, settled, type TaskChange } from "./store";

async function folder(ctx: BackgroundContext): Promise<string | null> {
  const dir = await ctx.data("conversation");
  return dir.ok ? dir.data : null;
}

export const taskRetention: Retention = {
  tab: "tasks",
  archiveAfterDays: 7,
  purgeAfterDays: 14,
  settled: async (ctx): Promise<SettledItem[]> => {
    const dir = await folder(ctx);
    const tasks = dir === null ? null : await readTasks(dir);
    return tasks === null || !tasks.ok ? [] : tasks.data.filter(settled).map(task => ({ id: String(task.number), at: task.updated }));
  },
  locate: async () => null,
  purge: async (ids, ctx) => {
    const dir = await folder(ctx);
    if (dir === null) return;
    await changeTasks(dir, async (tasks): Promise<TaskChange<null>> => {
      const left = tasks.filter(task => !settled(task) || !ids.includes(String(task.number)));
      return { tasks: left.length === tasks.length ? null : left, result: null };
    });
  },
};
