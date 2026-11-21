// pr-watch's daemon part: every 30s, observe the PRs linked to the tasks plugin's tasks and notify on changes.
import { join } from "node:path";
import { defineBackground, type PluginBackground } from "../../core/plugins";
import { watchOnce } from "./watch";

const background: PluginBackground = defineBackground({
  watchers: [{
    name: "prs", everyMs: 30_000,
    run: async ctx => {
      const dir = await ctx.data("conversation");
      await watchOnce(dir, join(dir, "..", "tasks", "tasks.json"), ctx.notify);
    },
  }],
  memory: null,
  runner: null,
  stop: null,
  remove: null,
});

export default background;
