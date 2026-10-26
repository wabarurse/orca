// Every account is a Claude Code or Codex subscription login.
import { claudeProfiles, readClaudeTokens, validateProfile } from "./claude";
import { codexProfiles, readCodexTokens } from "./codex";
import { loadConfig } from "../config";

export type ProviderName = "anthropic" | "openai";

export interface Account {
  /** "anthropic:<profile>" or "openai:<profile>". */
  id: string;
  provider: ProviderName;
  ok: boolean;
  active: boolean;
  source: string;
}

export const anthropicProfiles = claudeProfiles;
export const activeProfile = (configured: string) => validateProfile(configured || "default");

export async function accounts(): Promise<Account[]> {
  const config = await loadConfig();
  const out: Account[] = [];
  for (const name of ["anthropic", "openai"] as const) {
    const profiles = name === "anthropic" ? claudeProfiles() : codexProfiles();
    const read = name === "anthropic" ? readClaudeTokens : readCodexTokens;
    const active = activeProfile(name === "anthropic" ? config.account : config.openaiAccount);
    for (const profile of new Set([...profiles, active])) {
      const ok = await read(profile).then(Boolean).catch(() => false);
      out.push({ id: `${name}:${profile}`, provider: name, ok, active: ok && profile === active,
        source: ok ? (name === "anthropic" ? "claude code (claude subscription)" : "codex (chatgpt subscription)")
          : `not signed in or invalid credentials; /login ${name} ${profile}` });
    }
  }
  return out;
}
