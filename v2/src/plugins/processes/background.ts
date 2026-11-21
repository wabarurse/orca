// The processes plugin's daemon parts: a watcher that tells each owner, once, that its process ended (and enforces
// timeouts while it looks), and the conversation-delete hook that kills what is still running. Stopping the daemon
// does nothing to them on purpose: processes are detached and keep running; the next daemon's watcher picks them up.
import { put } from "../../core/inbox";
import { defineBackground, type PluginBackground } from "../../core/plugins";
import { describe, listProcs, markNotified, stopProc, tail } from "./store";

const background: PluginBackground = defineBackground({
  watchers: [{
    name: "ended", everyMs: 2_000,
    run: async ctx => {
      const dir = await ctx.data("conversation");
      for (const proc of await listProcs(dir)) {
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
    const dir = await ctx.data("conversation");
    for (const proc of await listProcs(dir)) if (proc.state === "running") await stopProc(dir, proc);
  },
});

export default background;
