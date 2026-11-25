import { readConversation } from "../conversations";
import { trustState } from "../trust";
import { enabledNames } from "./enable";
import { availablePlugins } from "./loader";
import type { PluginUi } from "./types";

export type EnabledUis = { directory: string | null; uis: { name: string; ui: PluginUi }[]; problems: string[]; active: string[] };

export async function enabledUis(conversation: string): Promise<EnabledUis> {
  const meta = await readConversation(conversation);
  const directory = meta?.directory ?? null;
  const trusted = directory === null ? false : await trustState(directory) === "trusted";
  const { plugins, problems } = await availablePlugins(directory, trusted);
  const notes = problems.map(p => `plugin ${p.name}: ${p.problem}`);
  const uis: { name: string; ui: PluginUi }[] = [];
  const active: string[] = [];
  for (const name of await enabledNames(conversation)) {
    const loaded = plugins.get(name);
    if (loaded === undefined) continue;
    active.push(name);
    const loadedUi = await loaded.ui();
    if (!loadedUi.ok) { notes.push(`plugin ${name} ui: ${loadedUi.error}`); continue; }
    if (loadedUi.data !== null) uis.push({ name, ui: loadedUi.data });
  }
  return { directory, uis, problems: notes, active };
}
