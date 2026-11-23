import { defineBackground, type PluginBackground } from "../../core/plugins";
import { settled } from "../../core/tools/registry";
import { describe, listProcs, markNotified, stopProc, tail } from "./store";

const background: PluginBackground = defineBackground({
  watchers: [{
    name: "ended", everyMs: 2_000,
    run: async ctx => {
      const dir = settled(await ctx.data("conversation"));
      for (const proc of settled(await listProcs(dir))) {
        if (proc.state === "running" || proc.notified) continue;
        const lines = (await tail(dir, proc.id, 20)).map(line => `  ${line}`);
        await ctx.tell(proc.owner, [`process ${describe(proc)}`, ...lines].join("\n"));
        await markNotified(dir, proc);
      }
    },
  }],
  memory: null,
  runner: null,
  stop: null,
  remove: async ctx => {
    const dir = settled(await ctx.data("conversation"));
    for (const proc of settled(await listProcs(dir))) if (proc.state === "running") await stopProc(dir, proc);
  },
});

export default background;
