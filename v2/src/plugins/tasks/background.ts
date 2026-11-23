import { defineBackground, type PluginBackground } from "../../core/plugins";
import { readTasks, settled, taskLine } from "./store";

const background: PluginBackground = defineBackground({
  watchers: [],
  memory: { title: "Tasks", text: async ctx => {
    const dir = await ctx.data("conversation");
    const tasks = dir.ok ? await readTasks(dir.data) : dir;
    return tasks.ok ? tasks.data.filter(t => !settled(t)).map(t => `- ${taskLine(t)}`).join("\n") : `(tasks unreadable: ${tasks.error})`;
  } },
  runner: null,
  stop: null,
  remove: null,
});

export default background;
