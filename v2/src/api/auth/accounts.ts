import { claudeProfiles, readClaudeTokens } from "./claude";
import { codexProfiles, readCodexTokens } from "./codex";
import { validateProfile } from "./oauth";
import { loadConfig } from "../../config";

export type ProviderName = "anthropic" | "openai";

export type AccountRef = { provider: ProviderName; profile: string };
export const accountId = (ref: AccountRef) => `${ref.provider}:${ref.profile}`;

export type Account = {
  id: string;
  provider: ProviderName;
  profile: string;
  ok: boolean;
  active: boolean;
  source: string;
};

export const activeProfile = (configured: string) => validateProfile(configured !== "" ? configured : "default");

export async function legacyProfile(name: ProviderName): Promise<string> {
  const config = await loadConfig();
  return activeProfile(name === "anthropic" ? config.account : config.openaiAccount);
}

export async function accounts(selected?: AccountRef): Promise<Account[]> {
  const out: Account[] = [];
  const names: ProviderName[] = ["anthropic", "openai"];
  for (const name of names) {
    const profiles = name === "anthropic" ? claudeProfiles() : codexProfiles();
    const read = name === "anthropic" ? readClaudeTokens : readCodexTokens;
    const extra = selected?.provider === name ? [validateProfile(selected.profile)] : [];
    for (const profile of new Set([...profiles, ...extra])) {
      const ok = await read(profile).then(tokens => tokens !== null).catch(() => false);
      out.push({ id: `${name}:${profile}`, provider: name, profile, ok, active: selected?.provider === name && selected.profile === profile,
        source: ok ? (name === "anthropic" ? "claude code (claude subscription)" : "codex (chatgpt subscription)")
          : `not signed in or invalid credentials; /login ${name} ${profile}` });
    }
  }
  return out;
}
