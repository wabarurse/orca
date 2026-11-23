import { join } from "node:path";
import { defineBackground, type PluginBackground } from "../../core/plugins";
import { settled } from "../../core/tools/registry";
import { watchOnce } from "./watch";

const background: PluginBackground = defineBackground({
  watchers: [{
    name: "prs", everyMs: 30_000,
    run: async ctx => {
      const dir = settled(await ctx.data("conversation"));
      settled(await watchOnce(dir, join(dir, "..", "tasks", "tasks.json"), ctx.notify));
    },
  }],
  memory: null,
  runner: null,
  stop: null,
  remove: null,
});

export default background;
