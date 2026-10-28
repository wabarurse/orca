// /accounts and /login: listing, switching and signing in to subscription accounts.

import { accountId, accounts, type Account, type AccountRef } from "../../login";
import { importClaudeCode, loginClaude } from "../../login";
import { importCodex, loginCodex } from "../../login";
import { provider, providerFor } from "../../providers";
import { effectiveAccount, effectiveModel, saveProjectAccount, seedProjectAccount } from "../../core/data/projects";
import { recentModels, type Choice } from "./model";

/** The account list for a project: exactly its one selected account is marked current. */
export async function accountChoices(dim: (s: string) => string, project?: string): Promise<Choice<Account>[]> {
  const selected = project ? await effectiveAccount(project) : undefined;
  return (await accounts(selected)).map((a) => ({ value: a, current: a.active, label: `${a.ok ? "○" : "✗"} ${a.id.padEnd(22)} ${dim(a.source)}` }));
}

/** Make a signed-in account the one this project uses from each agent's next model request on (other projects are untouched).
 * An account of another provider cannot serve the project's model, so the project's model becomes that provider's newest
 * one in the same commit; if the provider offers none, nothing changes. */
export async function useAccount(account: AccountRef, project: string, identity?: string, load: typeof provider = provider): Promise<string> {
  const model = await effectiveModel(project);
  if (providerFor(model) === account.provider) {
    await saveProjectAccount(project, account, undefined, identity);
    return `using ${accountId(account)} for this project (applies before each agent's next model request; other projects keep theirs)`;
  }
  const next = recentModels(await (await load(account.provider, { profile: account.profile })).models(), "")[0];
  if (!next) throw new Error(`${account.provider} offers no models for ${accountId(account)}; choose one with /model <id>`);
  await saveProjectAccount(project, account, { from: model, to: next }, identity);
  return `using ${accountId(account)} for this project; its model changed from ${model} to ${next} (${account.provider} cannot serve ${model}; /model picks another)`;
}

export const LOGIN_USAGE = "usage: /login anthropic [profile] [--from-claude-code]  |  /login openai [profile] [--from-codex]";

/** `/login <provider> [profile] [--from-...]`; returns what to tell the user, or throws. */
export async function login(arg: string, io: { write: (s: string) => void; signal: AbortSignal }, project?: { name: string; identity?: string; select?: boolean }): Promise<string> {
  const [alias = "", ...args] = arg.split(/\s+/).filter(Boolean);
  const name = alias === "claude" ? "anthropic" : alias === "codex" ? "openai" : alias;
  if (name !== "anthropic" && name !== "openai") return LOGIN_USAGE;
  const importFlag = name === "anthropic" ? "--from-claude-code" : "--from-codex";
  const names = args.filter((a) => a !== importFlag);
  if (names.length > 1 || names.some((n) => n.startsWith("--"))) return `usage: /login ${name} [profile] [${importFlag}]`;
  const profile = names[0] ?? "default";
  if (args.includes(importFlag)) await (name === "anthropic" ? importClaudeCode : importCodex)(profile);
  else await (name === "anthropic" ? loginClaude : loginCodex)(profile, io);
  const kind = name === "anthropic" ? "claude code / claude subscription" : "codex / chatgpt subscription";
  // Sign-in is global: it only stores credentials. The current project adopts the account only if it has not chosen one.
  // `select` (signing in from /accounts) is an explicit choice of this account for the project.
  // The credentials are saved either way: a failed project selection is reported, never a failed sign-in.
  const signedIn = `signed in to ${name}:${profile} (${kind})`;
  try {
    if (project?.select) return `${signedIn}; ${await useAccount({ provider: name, profile }, project.name, project.identity)}`;
    const seeded = project ? await seedProjectAccount(project.name, { provider: name, profile }, project.identity) : false;
    return `${signedIn}; ${seeded ? "this project now uses it" : "choose it for a project with /accounts"}`;
  } catch (error) { return `${signedIn}; not selected for this project: ${error instanceof Error ? error.message : String(error)}`; }
}
