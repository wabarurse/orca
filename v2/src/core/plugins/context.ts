// The context background code gets (watchers, memory sections, stop/remove hooks), built one way everywhere.
import { pluginData } from "../bubbles";
import { put } from "../inbox";
import { listRuns, live } from "../runner/runs";
import { toInfo } from "../runner/runtime";
import type { BackgroundContext } from "./types";

export function backgroundContext(conversation: string, plugin: string, directory: string): BackgroundContext {
  const send = async (to: string, text: string): Promise<void> => { await put(conversation, to, plugin, text, { images: [], delivery: "steer" }); };
  return {
    plugin, conversation, directory,
    data: scope => pluginData(conversation, plugin, scope),
    notify: text => send("orchestrator", text),
    async tell(agent, text) {
      const run = (await listRuns(conversation)).find(r => r.agent === agent);
      await send(agent === "orchestrator" || (run !== undefined && live(run)) ? agent : "orchestrator", agent === "orchestrator" || (run !== undefined && live(run)) ? text : `(for ${agent}, which is not running) ${text}`);
    },
    agents: async () => (await listRuns(conversation)).filter(r => r.agent !== "orchestrator").map(toInfo),
  };
}
