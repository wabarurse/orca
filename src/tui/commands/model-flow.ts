// /model [orch|worker|reviewer]: the scope step (all agents or one role), then the picker of the project's account's models for
// that scope, the scoped confirmation, and the save. The App supplies the UI through ModelHost; the logic stays here.

import { saveRoleModel, validateModel } from "../../core/data/projects";
import type { Role } from "../../protocol";
import { activeRoles, NEXT_REQUEST, type Choice, type RoleModels } from "./model";
import { chooseScope, scopeNames, type Scope } from "./scope";

export interface ModelHost {
  project: string;
  /** The project identity captured when the command ran: saves refuse a deleted/recreated project. */
  identity: string;
  dim(text: string): string;
  /** The page and the model operation are still the ones the command ran on. */
  current(): boolean;
  note(text: string): void;
  /** Drop the "fetching models…" note. */
  unnote(): void;
  open<T>(title: string, choices: Choice<T>[], pick: (value: T) => Promise<void> | void): void;
  /** Save at once, or after the confirmation for `scope` when agents it applies to run (switchAllMenu). */
  confirm(question: string, scope: Scope, save: () => Promise<void>): Promise<void>;
  projectModel(): Promise<string>;
  /** The account's models (modelChoices). */
  choices(): Promise<{ choices: Choice<string>[]; errors: string[] }>;
  /** Save the project model for all agents (setModel). */
  saveAll(id: string): Promise<string>;
  refresh(): Promise<void>;
  /** Ask the orchestrator daemon to acknowledge the model its next request uses. */
  observe(id: string): void;
}

/** The scope step; `arg` (a role, never a model id) skips it. */
export async function chooseModel(arg: string, host: ModelHost): Promise<void> {
  const model = await host.projectModel();
  if (!host.current()) return;
  const roles = activeRoles(host.project, model);
  const describe = (scope: Scope) => scope === "all"
    ? `${model}${Object.keys(roles).length ? host.dim("  clears the role choices") : ""}`
    : roles[scope] ?? `${model}${host.dim("  same as project")}`;
  return chooseScope(arg, {
    command: "/model", title: "switch model for   (/model orch|worker|reviewer skips this)", describe,
    open: (title, choices, pick) => host.open(title, choices, pick), note: host.note,
    then: (scope) => pickModel(host, scope, model, roles),
  });
}

/** The picker rows for `scope`: the account's models with the scope's current one marked; a role also gets "same as project". */
export function scopedChoices(choices: Choice<string>[], scope: Scope, model: string, roles: RoleModels, dim: (s: string) => string): Choice<string | null>[] {
  if (scope === "all") return choices.map((c) => ({ ...c, current: c.value === model }));
  const override = roles[scope];
  return [{ value: null, label: `same as project  ${dim(model)}`, current: !override }, ...choices.map((c) => ({ ...c, current: c.value === override }))];
}

async function pickModel(host: ModelHost, scope: Scope, model: string, roles: RoleModels): Promise<void> {
  host.note("fetching models…");
  const { choices, errors } = await host.choices();
  host.unnote();
  if (!host.current()) return;
  for (const e of errors) host.note(host.dim(e));
  if (!choices.length) return host.note(host.dim("no models available; sign in with /login first"));
  host.open(`switch model for ${scopeNames[scope]}   (/accounts for another provider)`, scopedChoices(choices, scope, model, roles, host.dim), (id) => {
    if (id !== null) validateModel(id);
    if (scope === "all") return host.confirm(`switch this project to ${id}?`, "all", () => saveAll(host, id!));
    const override = id === null || id === model ? undefined : id; // the project model itself is "same as project"
    const question = override ? `switch ${scopeNames[scope]} to ${override}?` : `return ${scopeNames[scope]} to the project model ${model}?`;
    return host.confirm(question, scope, () => saveRole(host, scope, override, model));
  });
}

async function saveAll(host: ModelHost, id: string): Promise<void> {
  if (!host.current()) return;
  // Persistence boundary: once invoked, this commit belongs to the captured project even if its page closes or selection
  // changes. Disk identity and the shared project-state lock protect deletion/recreation, not selection.
  host.note(await host.saveAll(id));
  await host.refresh();
  host.observe(id); // the daemon reads the saved model at its next request; its acknowledgement replaces the note
}

/** One role's model: `id` overrides the project model for that role's agents; undefined ("same as project") clears the override. */
export async function setRoleModel(project: string, role: Role, id: string | undefined, identity?: string): Promise<string> {
  await saveRoleModel(project, role, id, identity);
  return `${scopeNames[role]} ${id ? `set to ${id}` : "back on the project model"} (applies before each of their next model requests; ${NEXT_REQUEST})`;
}

async function saveRole(host: ModelHost, role: Role, id: string | undefined, model: string): Promise<void> {
  if (!host.current()) return;
  try { host.note(await setRoleModel(host.project, role, id, host.identity)); }
  catch (error) { return host.note(host.dim(error instanceof Error ? error.message : String(error))); } // nothing saved: e.g. another provider's model
  await host.refresh();
  if (role === "orchestrator") host.observe(id ?? model);
}
