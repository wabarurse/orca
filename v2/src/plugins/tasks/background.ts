// The tasks plugin's daemon part: open tasks kept verbatim beside the orchestrator's rolling memory.
import { defineBackground, type PluginBackground } from "../../core/plugins";
import { readTasks, settled, taskLine } from "./store";

const background: PluginBackground = defineBackground({
  watchers: [],
  memory: { title: "Tasks", text: async ctx => (await readTasks(await ctx.data("conversation"))).filter(t => !settled(t)).map(t => `- ${taskLine(t)}`).join("\n") },
  runner: null,
  stop: null,
  remove: null,
});

export default background;
