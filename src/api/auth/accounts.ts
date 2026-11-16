// Every account is a Claude Code or Codex subscription login.
import { claudeProfiles, readClaudeTokens } from "./claude";
import { codexProfiles, readCodexTokens } from "./codex";
import { validateProfile } from "./oauth";
import { loadConfig } from "../../config";

import type { Account, AccountRef, ProviderName } from "../../types";

export const accountId = (ref: AccountRef) => `${ref.provider}:${ref.profile}`;

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
