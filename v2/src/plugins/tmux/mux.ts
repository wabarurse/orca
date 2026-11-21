import { loadConfig, saveConfig } from "../../config";
import { readConversation } from "../../core/conversations";
import { availablePlugins, enabledNames, type Command, type UiHost } from "../../core/plugins";
import { trustState } from "../../core/trust";

export async function runnerNames(conversation: string): Promise<string[]> {
  const directory = (await readConversation(conversation))?.directory ?? null;
  const trusted = directory !== null && await trustState(directory) === "trusted";
  const { plugins } = await availablePlugins(directory, trusted);
  const names = ["plain"];
  for (const name of await enabledNames(conversation)) {
    const loaded = plugins.get(name);
    const background = loaded === undefined ? null : await loaded.background();
    const runner = background !== null && background.ok ? background.data?.runner ?? null : null;
    if (runner !== null && !names.includes(runner.name)) names.push(runner.name);
  }
  return names;
}

async function choose(name: string, host: UiHost): Promise<void> {
  await saveConfig({ runner: name });
  host.note(`new agents start in ${name}; running ones stay where they are`);
}

export const muxCommand: Command = {
  name: "mux",
  description: "choose where new agents run: /mux [plain|<runner>]",
  async run(args, host) {
    const names = await runnerNames(host.conversation);
    const wanted = args.trim();
    if (wanted.length > 0) {
      if (names.includes(wanted)) await choose(wanted, host);
      else host.note(`unknown runner ${wanted}; choose ${names.join(", ")}`);
      return;
    }
    const current = (await loadConfig()).runner;
    const picked = await host.pick("runner for new agents", names.map(n => n === current ? `${n} (current)` : n));
    const name = picked === null ? undefined : names[picked];
    if (name !== undefined) await choose(name, host);
  },
};
