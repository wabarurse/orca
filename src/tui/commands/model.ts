// /model and /effort: the choices they offer and what picking one saves.

import { accounts, type ProviderName } from "../../login/accounts";
import { provider } from "../../providers/account";
import { providerFor } from "../../providers/provider";
import { modelCapabilities } from "../../providers/catalog/capabilities";
import { prefetchContextLimits } from "../../providers/catalog/context-window";
import { loadConfig, saveConfig } from "../../config/config";
import { effectiveModel, saveProjectModel, validateModel } from "../../core/data/projects/project-model";
import { effectiveSettingsReport } from "../../core/data/projects/project-settings";

export interface Choice<T> { value: T; label: string; current?: boolean }

/** How many of each provider's newest models /model offers. */
export const RECENT_MODELS = 6;

/** The newest `limit` ids, keeping `current` in the list even when it is older. */
export function recentModels(ids: string[], current: string, limit = RECENT_MODELS): string[] {
  const head = ids.slice(0, limit);
  return ids.includes(current) && !head.includes(current) ? [...head, current] : head;
}

/** The newest models of every active provider; errors are reported per provider. */
export async function modelChoices(dim: (s: string) => string, project?: string): Promise<{ choices: Choice<string>[]; errors: string[]; current: string }> {
  const model = project ? await effectiveModel(project) : (await loadConfig()).model;
  const choices: Choice<string>[] = [];
  const errors: string[] = [];
  for (const a of await accounts()) {
    if (!a.active) continue;
    try {
      const ids = await (await provider(a.provider as ProviderName)).models();
      for (const id of recentModels(ids, model)) choices.push({ value: id, current: id === model, label: `${id}  ${dim(a.provider)}` });
    } catch (err) {
      errors.push(`${a.provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { choices, errors, current: model };
}

/** Effort picker choices for the project's current model: "default" plus the levels it supports, current marked.
 * Levels come from the provider catalog (fetched once per process, like context limits) and fall back to the
 * built-in table. `note` explains a saved effort the current list lacks (used as default, kept on disk). */
export async function effortChoices(project: string, load: typeof provider = provider): Promise<{ choices: Choice<string>[]; model: string; current: string; note?: string }> {
  const model = await effectiveModel(project);
  try { await prefetchContextLimits(await load(providerFor(model))); } catch { /* no account/catalog: built-in levels */ }
  const { settings, dropped } = await effectiveSettingsReport(project, model);
  const current = settings.effort ?? "default";
  const choices = ["default", ...modelCapabilities(model).effort].map((value) => ({ value, label: value, current: value === current }));
  return { choices, model, current, ...(dropped ? { note: `saved effort ${dropped} is not supported for ${model} by the current capability list; requests use the default until another level is chosen` } : {}) };
}

export async function setModel(id: string, project?: string, identity?: string): Promise<string> {
  validateModel(id);
  if (project) await saveProjectModel(project, id, identity);
  else await saveConfig({ model: id }); // Retain the programmatic global-default API.
  return `model set to ${id} (applies before each agent’s next model request; running tools finish; failed/stopped turns need another message to resume; exited agents require restart)`;
}

