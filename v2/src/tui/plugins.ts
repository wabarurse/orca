import { pluginData } from "../core/bubbles";
import { linksFor } from "../core/plugins";
import { readConversation } from "../core/conversations";
import { availablePlugins } from "../core/plugins/loader";
import { enabledNames } from "../core/plugins/enable";
import type { Fold, PluginContext, PluginUi } from "../core/plugins/types";
import { registerToolLine } from "../core/toolview";
import { trustState } from "../core/trust";
import { CORE_FOLDS } from "./view";

export type BoundUi = { name: string; ui: PluginUi; ctx: PluginContext };

export async function loadUis(conversation: string): Promise<{ uis: BoundUi[]; folds: Map<string, Fold>; problems: string[]; active: string[] }> {
  const meta = await readConversation(conversation);
  const directory = meta?.directory ?? null;
  const trusted = directory === null ? false : await trustState(directory) === "trusted";
  const { plugins, problems } = await availablePlugins(directory, trusted);
  const uis: BoundUi[] = [];
  const folds = new Map<string, Fold>(CORE_FOLDS);
  const notes = problems.map(p => `plugin ${p.name}: ${p.problem}`);
  const active: string[] = [];
  for (const name of await enabledNames(conversation)) {
    const loaded = plugins.get(name);
    if (loaded === undefined) continue;
    active.push(name);
    const loadedUi = await loaded.ui();
    if (!loadedUi.ok) { notes.push(`plugin ${name} ui: ${loadedUi.error}`); continue; }
    const ui = loadedUi.data;
    if (ui === null) continue;
    const ctx: PluginContext = { plugin: name, conversation, agent: "user", role: "orchestrator", branch: null, cwd: directory ?? "", data: scope => pluginData(conversation, name, scope), links: linksFor(conversation, name) };
    uis.push({ name, ui, ctx });
    for (const [tool, line] of Object.entries(ui.toolLines)) registerToolLine(tool, line.label, line.summary);
    for (const [tool, fold] of Object.entries(ui.folds)) folds.set(tool, fold);
  }
  return { uis, folds, problems: notes, active };
}
