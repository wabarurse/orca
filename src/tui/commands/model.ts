// /model and /effort: the choices they offer and what picking one saves.

import { provider } from "../../providers";
import { modelCapabilities } from "../../providers/catalog";
import { prefetchContextLimits } from "../../providers/catalog";
import { loadConfig, saveConfig } from "../../config";
import { accountForModel, effectiveAccount, effectiveModel, roleOverrides, saveProjectModel, validateModel } from "../../core/data/projects";
import type { Role } from "../../protocol";
import { accountId } from "../../login";
import { effectiveSettingsReport } from "../../core/data/projects";

export interface Choice<T> { value: T; label: string; current?: boolean }

/** How many of each provider's newest models /model offers. */
export const RECENT_MODELS = 6;

/** The newest `limit` ids, keeping `current` in the list even when it is older. */
export function recentModels(ids: string[], current: string, limit = RECENT_MODELS): string[] {
  const head = ids.slice(0, limit);
  return ids.includes(current) && !head.includes(current) ? [...head, current] : head;
}

/** The newest models of the project's one selected account (another provider's models come with choosing its account in /accounts). */
export async function modelChoices(dim: (s: string) => string, project?: string): Promise<{ choices: Choice<string>[]; errors: string[]; current: string }> {
  const model = project ? await effectiveModel(project) : (await loadConfig()).model;
  const account = project ? await effectiveAccount(project) : await accountForModel(model, undefined);
  const choices: Choice<string>[] = [];
  const errors: string[] = [];
  try {
    const ids = await (await provider(account.provider, { profile: account.profile })).models();
    for (const id of recentModels(ids, model)) choices.push({ value: id, current: id === model, label: `${id}  ${dim(account.provider)}` });
  } catch (err) {
    errors.push(`${account.provider}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { choices, errors, current: model };
}

/** Effort picker choices for the project's current model: "default" plus the levels it supports, current marked.
 * Levels come from the provider catalog (fetched once per process, like context limits) and fall back to the
 * built-in table. `note` explains a saved effort the current list lacks (used as default, kept on disk). */
export async function effortChoices(project: string, load: typeof provider = provider): Promise<{ choices: Choice<string>[]; model: string; current: string; note?: string }> {
  const model = await effectiveModel(project);
  try { const account = await effectiveAccount(project); await prefetchContextLimits(await load(account.provider, { profile: account.profile })); } catch { /* no account/catalog: built-in levels */ }
  const { settings, dropped } = await effectiveSettingsReport(project, model);
  const current = settings.effort ?? "default";
  const choices = ["default", ...modelCapabilities(model).effort].map((value) => ({ value, label: value, current: value === current }));
  return { choices, model, current, ...(dropped ? { note: `saved effort ${dropped} is not supported for ${model} by the current capability list; requests use the default until another level is chosen` } : {}) };
}

export const NEXT_REQUEST = "running tools finish; failed/stopped turns need another message to resume; exited agents require restart";

/** "All agents": the project model, which also clears the role overrides of its provider (saveProjectModel). */
export async function setModel(id: string, project?: string, identity?: string): Promise<string> {
  validateModel(id);
  if (project) await saveProjectModel(project, id, identity);
  else await saveConfig({ model: id }); // Retain the programmatic global-default API.
  return `model set to ${id} (applies before each agent’s next model request; ${NEXT_REQUEST})`;
}

export type RoleModels = Partial<Record<Role, string>>;
/** The role overrides that apply with project model `model` (core roleOverrides); none when they cannot be read, for display only. */
export function activeRoles(project: string, model: string): RoleModels {
  try { return roleOverrides(project, model); } catch { return {}; }
}
const SHORT: Readonly<Record<Role, string>> = { orchestrator: "orch", worker: "workers", reviewer: "reviewers" };
/** The header's model field: each role's effective model (its override from roleOverrides, else the project model), compact when
 * every role uses the project model: `claude-opus-5-5 · all roles`, else `orch opus · workers sonnet · reviewers haiku`. */
export function roleModelsLabel(model: string, roles: RoleModels | undefined): string {
  const per = (["orchestrator", "worker", "reviewer"] as const).map((role) => [SHORT[role], roles?.[role] ?? model] as const);
  return per.every(([, m]) => m === model) ? `${model} · all roles` : per.map(([who, m]) => `${who} ${m}`).join(" · ");
}
/** The header's account: the project's selected account as provider:profile; undefined when it cannot be read (shown as nothing). */
export function pageAccount(project: string): Promise<string | undefined> {
  return effectiveAccount(project).then(accountId, () => undefined);
}

