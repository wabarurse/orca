import { errorMessage, fail, ok, type Result } from "../../config";
import { pluginData } from "../bubbles";
import { readConversation } from "../conversations";
import { put } from "../inbox";
import { listRuns, live } from "../runner/runs";
import { trustState } from "../trust";
import { enabledNames } from "./enable";
import { availablePlugins, type LoadedPlugin } from "./loader";
import type { BackgroundContext, Links } from "./types";

type Enabled = { directory: string; plugins: LoadedPlugin[] };

async function enabledPlugins(conversation: string): Promise<Result<Enabled>> {
  const meta = await readConversation(conversation);
  if (meta === null) return fail(`no conversation ${conversation}`);
  const { plugins } = await availablePlugins(meta.directory, await trustState(meta.directory) === "trusted");
  const names = await enabledNames(conversation);
  return ok({ directory: meta.directory, plugins: names.flatMap(name => { const loaded = plugins.get(name); return loaded === undefined ? [] : [loaded]; }) });
}

export function linksFor(conversation: string, from: string): Links {
  return {
    async call(plugin, service, input) {
      const enabled = await enabledPlugins(conversation);
      if (!enabled.ok) return enabled;
      const provider = enabled.data.plugins.find(p => p.plugin.name === plugin);
      if (provider === undefined) return fail(`plugin ${plugin} is not on in this bubble`);
      const found = provider.plugin.provides.find(s => s.name === service);
      if (found === undefined) return fail(`${plugin} provides no service ${service}; it provides ${provider.plugin.provides.length === 0 ? "none" : provider.plugin.provides.map(s => s.name).join(", ")}`);
      try { return await found.run(input, { ...backgroundContext(conversation, plugin, enabled.data.directory), from }); }
      catch (error) { return fail(`${plugin}/${service} failed: ${errorMessage(error)}`); }
    },
    async emit(event, payload) {
      const enabled = await enabledPlugins(conversation);
      if (!enabled.ok) return enabled;
      const declared = enabled.data.plugins.find(p => p.plugin.name === from)?.plugin.emits.find(e => e.name === event);
      if (declared === undefined) return fail(`${from} does not declare the event ${event}`);
      const checked = declared.check(payload);
      if (!checked.ok) return checked;
      let delivered = 0;
      for (const listener of enabled.data.plugins) for (const on of listener.plugin.on) {
        if (on.event !== `${from}/${event}`) continue;
        try { await on.run(checked.data, { ...backgroundContext(conversation, listener.plugin.name, enabled.data.directory), from }); delivered++; }
        catch (error) { process.stderr.write(`${listener.plugin.name} on ${from}/${event}: ${errorMessage(error)}\n`); }
      }
      return ok(delivered);
    },
    async runner() {
      const { selectedRunner } = await import("../runner/runtime");
      return selectedRunner(conversation);
    },
    async runnerNamed(name) {
      const { runners } = await import("../runner/runtime");
      return (await runners(conversation)).find(r => r.name === name) ?? null;
    },
  };
}

export function backgroundContext(conversation: string, plugin: string, directory: string): BackgroundContext {
  const send = async (to: string, text: string): Promise<void> => { await put(conversation, to, plugin, text, { images: [], delivery: "steer" }); };
  return {
    plugin, conversation, directory,
    data: scope => pluginData(conversation, plugin, scope),
    links: linksFor(conversation, plugin),
    notify: text => send("orchestrator", text),
    async tell(agent, text) {
      const run = (await listRuns(conversation)).find(r => r.agent === agent);
      await send(agent === "orchestrator" || (run !== undefined && live(run)) ? agent : "orchestrator", agent === "orchestrator" || (run !== undefined && live(run)) ? text : `(for ${agent}, which is not running) ${text}`);
    },
    agents: async () => {
      const { toInfo } = await import("../runner/runtime");
      return (await listRuns(conversation)).filter(r => r.agent !== "orchestrator").map(toInfo);
    },
  };
}
