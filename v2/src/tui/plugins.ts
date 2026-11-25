import { pluginData } from "../core/bubbles";
import { linksFor } from "../core/plugins";
import { enabledUis } from "../core/plugins/uis";
import type { Fold, PluginContext, PluginUi } from "../core/plugins/types";
import { registerToolLine } from "../core/toolview";
import { CORE_FOLDS } from "./view";

export type BoundUi = { name: string; ui: PluginUi; ctx: PluginContext };

export async function loadUis(conversation: string): Promise<{ uis: BoundUi[]; folds: Map<string, Fold>; problems: string[]; active: string[] }> {
  const { directory, uis: enabled, problems, active } = await enabledUis(conversation);
  const uis: BoundUi[] = [];
  const folds = new Map<string, Fold>(CORE_FOLDS);
  for (const { name, ui } of enabled) {
    const ctx: PluginContext = { plugin: name, conversation, agent: "user", role: "orchestrator", branch: null, cwd: directory ?? "", data: scope => pluginData(conversation, name, scope), links: linksFor(conversation, name) };
    uis.push({ name, ui, ctx });
    for (const [tool, line] of Object.entries(ui.toolLines)) registerToolLine(tool, line.label, line.summary);
    for (const [tool, fold] of Object.entries(ui.folds)) folds.set(tool, fold);
  }
  return { uis, folds, problems, active };
}
