// Every account is a Claude Code or Codex subscription login.
import { claudeProfiles, readClaudeTokens, validateProfile } from "./claude";
import { codexProfiles, readCodexTokens } from "./codex";
import { loadConfig } from "../config";

export type ProviderName = "anthropic" | "openai";

/** One subscription login: a provider and one of its profiles. A project selects exactly one. */
export interface AccountRef { provider: ProviderName; profile: string }
export const accountId = (ref: AccountRef) => `${ref.provider}:${ref.profile}`;

export interface Account {
  /** "anthropic:<profile>" or "openai:<profile>". */
  id: string;
  provider: ProviderName;
  profile: string;
  ok: boolean;
  active: boolean;
  source: string;
}

export const anthropicProfiles = claudeProfiles;
export const activeProfile = (configured: string) => validateProfile(configured || "default");

/** The pre-per-project global profile for a provider (config `account` / `openaiAccount`): read only, as the fallback of
 * a project that has not chosen an account. Nothing writes it any more. */
export async function legacyProfile(name: ProviderName): Promise<string> {
  const config = await loadConfig();
  return activeProfile(name === "anthropic" ? config.account : config.openaiAccount);
}

/** Every known login. Only `selected` (the asking project's account) is marked active, so at most one row is. */
export async function accounts(selected?: AccountRef): Promise<Account[]> {
  const out: Account[] = [];
  for (const name of ["anthropic", "openai"] as const) {
    const profiles = name === "anthropic" ? claudeProfiles() : codexProfiles();
    const read = name === "anthropic" ? readClaudeTokens : readCodexTokens;
    const extra = selected?.provider === name ? [validateProfile(selected.profile)] : [];
    for (const profile of new Set([...profiles, ...extra])) {
      const ok = await read(profile).then(Boolean).catch(() => false);
      out.push({ id: `${name}:${profile}`, provider: name, profile, ok, active: selected?.provider === name && selected.profile === profile,
        source: ok ? (name === "anthropic" ? "claude code (claude subscription)" : "codex (chatgpt subscription)")
          : `not signed in or invalid credentials; /login ${name} ${profile}` });
    }
  }
  return out;
}
