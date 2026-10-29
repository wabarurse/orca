import { effectiveSettings } from "./project-settings";
import type { RequestSettings } from "../../../providers/catalog";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./state";
// A project override never changes the default used by other projects.
import { loadConfig, readProjectState, writeProjectState } from "../../../config";
import { provider, providerFor, type Provider } from "../../../providers";
import type { ProviderName } from "../../../login";
import type { Role } from "../../../protocol";
import { prefetchContextLimits } from "../../../providers/catalog";
import { accountForModel } from "./project-account";

function validateProject(project: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(project) || project === "." || project === "..") throw new Error("invalid project id");
}
export function validateModel(model: string): void {
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model) || model.length > 200) throw new Error("invalid model id");
}
/** The project model; with `role`, the model that role uses: its override when one applies (see roleOverrides), else the project model. */
export async function effectiveModel(project: string, role?: Role): Promise<string> {
  validateProject(project);
  const saved = readProjectState<string>(project, "model");
  const model = saved === undefined ? (await loadConfig()).model : saved;
  validateModel(model);
  return role ? roleOverrides(project, model)[role] ?? model : model;
}
export function saveProjectModel(project: string, model: string, identity?: string): Promise<void> {
  // Capture identity and reserve queue position synchronously, before any await.
  try {
    validateModel(model);
    validateProject(project);
    const expected = identity ?? projectIdentity(project);
    return withProjectStateLock(project, () => commitModel(project, model, expected));
  } catch (error) { return Promise.reject(error); }
}
/** Saving the project model is "all agents": in the same commit it clears the role overrides of the new model's provider. */
async function commitModel(project: string, model: string, identity: string): Promise<void> {
  assertProjectIdentity(project, identity, "switching model");
  const saved = savedRoleModels(project);
  writeProjectState(project, "model", model);
  if (saved[providerFor(model)]) writeRoleModels(project, { ...saved, [providerFor(model)]: {} });
}

// Per-role overrides (key `role-models`): for each provider, the model a role uses instead of the project model. Kept per provider
// like `provider-models`, so switching the account to another provider (/accounts) leaves them dormant, and switching back restores them.
export const modelRoles = ["orchestrator", "worker", "reviewer"] as const satisfies readonly Role[];
export type RoleModels = Partial<Record<Role, string>>;
type SavedRoleModels = Partial<Record<ProviderName, RoleModels>>;
const validId = (model: unknown): model is string => typeof model === "string" && model.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** The saved overrides; a malformed record fails closed, an entry that is not a model of its provider is skipped. */
function savedRoleModels(project: string): SavedRoleModels {
  const saved = readProjectState<unknown>(project, "role-models");
  if (saved === undefined) return {};
  if (!isRecord(saved)) throw new Error("invalid project role models");
  const out: SavedRoleModels = {};
  for (const name of ["anthropic", "openai"] as const) {
    const entry = saved[name];
    if (!isRecord(entry)) continue;
    const roles: RoleModels = {};
    for (const role of modelRoles) { const model = entry[role]; if (validId(model) && providerFor(model) === name) roles[role] = model; }
    out[name] = roles;
  }
  return out;
}
function writeRoleModels(project: string, saved: SavedRoleModels): void {
  const next = Object.fromEntries(Object.entries(saved).filter(([, roles]) => roles && Object.keys(roles).length));
  writeProjectState(project, "role-models", next);
}
/** The overrides that apply with project model `model`: its provider's, minus any equal to it (another provider's are ignored).
 * The one role resolution the agents (effectiveModel with a role), the header and /model share. */
export function roleOverrides(project: string, model: string): RoleModels {
  validateProject(project);
  const roles = { ...savedRoleModels(project)[providerFor(model)] };
  for (const role of modelRoles) if (roles[role] === model) delete roles[role];
  return roles;
}
/** Set (`model`) or clear (undefined, or the project model itself) `role`'s override for the project model's provider. The model
 * must be one that provider serves, i.e. the project's account; checked again under the lock. */
export function saveRoleModel(project: string, role: Role, model: string | undefined, identity?: string): Promise<void> {
  try {
    validateProject(project);
    if (!modelRoles.includes(role)) throw new Error("invalid role");
    if (model !== undefined) validateModel(model);
    const expected = identity ?? projectIdentity(project);
    return withProjectStateLock(project, async () => {
      assertProjectIdentity(project, expected, "switching model");
      const current = await effectiveModel(project);
      const name = providerFor(current);
      if (model !== undefined && providerFor(model) !== name) throw new Error(`${model} is not served by this project's ${name} account; /accounts switches provider`);
      const saved = savedRoleModels(project);
      const roles = { ...saved[name] };
      if (model === undefined || model === current) delete roles[role]; else roles[role] = model;
      writeRoleModels(project, { ...saved, [name]: roles });
    });
  } catch (error) { return Promise.reject(error); }
}

/** Re-read just before each request, never during a tool or an in-flight call. With `role`, that role's override applies when it is
 * set for the project model's provider; otherwise (and without `role`) the project model. Settings are the chosen model's own. */
export function projectModelResolver(project: string, load: typeof provider = provider, role?: Role): () => Promise<{ model: string; provider: Provider; settings: RequestSettings }> {
  return async () => {
    const model = await effectiveModel(project, role);
    try {
      const account = await accountForModel(model, readProjectState<unknown>(project, "account")); // an override has the project model's provider, so this is the project's account, never a global one
      const selected = await load(account.provider, { profile: account.profile });
      prefetchContextLimits(selected); // Background only: the turn never waits on the catalog.
      return { model, provider: selected, settings: await effectiveSettings(project, model) };
    }
    catch (error) { throw new Error(`cannot load provider for project ${project} model ${model}: ${error instanceof Error ? error.message : error}`); }
  };
}
