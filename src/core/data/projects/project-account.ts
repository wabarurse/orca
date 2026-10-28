// The one subscription account a project uses: a provider and a profile, saved in the project's own state.
// Another project, and the global config, are never touched. The provider must serve the project's model.
import { readProjectState, writeProjectState } from "../../../config";
import { legacyProfile, type AccountRef } from "../../../login";
import { providerFor } from "../../../providers";
import { effectiveModel, validateModel } from "./project-model";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./state";

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const validRef = (value: unknown): value is AccountRef => !!value && typeof value === "object" && !Array.isArray(value) &&
  ((value as AccountRef).provider === "anthropic" || (value as AccountRef).provider === "openai") && PROFILE.test((value as AccountRef).profile);

/** The account for `model`: the saved choice when its provider serves the model, otherwise the old global profile of the
 * model's provider. A pure read: a project without a choice is not rewritten, and other projects are never consulted. */
export async function accountForModel(model: string, saved: unknown): Promise<AccountRef> {
  const provider = providerFor(model);
  if (saved !== undefined && !validRef(saved)) throw new Error("invalid project account");
  return saved?.provider === provider ? saved : { provider, profile: await legacyProfile(provider) };
}

/** The project's selected account, derived from its model so exactly one account is ever selected. */
export async function effectiveAccount(project: string): Promise<AccountRef> {
  return accountForModel(await effectiveModel(project), readProjectState<unknown>(project, "account"));
}

type LastModels = Partial<Record<AccountRef["provider"], string>>;
/** The last model this project used on each provider (key `provider-models`), recorded when the project leaves that provider. */
function lastModels(project: string): LastModels {
  const saved = readProjectState<unknown>(project, "provider-models");
  if (saved === undefined) return {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("invalid project provider models");
  const out: LastModels = {};
  for (const name of ["anthropic", "openai"] as const) {
    const model = (saved as Record<string, unknown>)[name];
    if (typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model) && providerFor(model) === name) out[name] = model;
  }
  return out;
}
/** The model this project last used on `provider`, if any; the caller still checks the provider offers it. */
export function lastProviderModel(project: string, provider: AccountRef["provider"]): string | undefined {
  return lastModels(project)[provider];
}

/** Select `account` for this project only. With `change`, the project's model changes in the same locked commit (an account of
 * another provider needs a model that provider serves) and the model it leaves is remembered for its provider; the commit fails
 * if the model is no longer the one the caller read. */
export function saveProjectAccount(project: string, account: AccountRef, change: { from: string; to: string } | undefined, identity?: string): Promise<void> {
  try {
    if (!validRef(account)) throw new Error("invalid account");
    if (change) validateModel(change.to);
    const expected = identity ?? projectIdentity(project);
    return withProjectStateLock(project, async () => {
      assertProjectIdentity(project, expected, "switching account");
      const model = await effectiveModel(project);
      if (change ? model !== change.from : providerFor(model) !== account.provider) throw new Error("model changed while switching account; try again");
      if (change && providerFor(change.to) !== account.provider) throw new Error(`${change.to} is not served by ${account.provider}`);
      writeProjectState(project, "account", { provider: account.provider, profile: account.profile });
      if (!change) return;
      writeProjectState(project, "provider-models", { ...lastModels(project), [providerFor(change.from)]: change.from });
      writeProjectState(project, "model", change.to);
    });
  } catch (error) { return Promise.reject(error); }
}

/** After a sign-in: give a project that has not chosen an account this one, when it serves the project's model. Never replaces a
 * saved choice, never changes the model, and writes nothing for another project. Returns whether it was selected. */
export function seedProjectAccount(project: string, account: AccountRef, identity?: string): Promise<boolean> {
  try {
    if (!validRef(account)) throw new Error("invalid account");
    const expected = identity ?? projectIdentity(project);
    return withProjectStateLock(project, async () => {
      assertProjectIdentity(project, expected, "selecting account");
      if (readProjectState<unknown>(project, "account") !== undefined || providerFor(await effectiveModel(project)) !== account.provider) return false;
      writeProjectState(project, "account", { provider: account.provider, profile: account.profile });
      return true;
    });
  } catch (error) { return Promise.reject(error); }
}
