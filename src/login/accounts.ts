// Every account is a Claude Code or Codex subscription login.
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_BETAS, claudeCredentials, claudeProfiles, readClaudeTokens, validateProfile } from "./claude";
import { codexCredentials, codexProfiles, readCodexTokens } from "./codex";
import { loadConfig } from "../config/config";
import { anthropic } from "../providers/anthropic";
import type { Provider, ProviderName } from "../providers/index";
import { openai } from "../providers/openai";

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

export async function provider(name: ProviderName, options: { promptCache?: boolean } = {}): Promise<Provider> {
  const config = await loadConfig();
  const profile = activeProfile(name === "anthropic" ? config.account : config.openaiAccount);
  if (name === "anthropic") {
    // The SDK otherwise lets this legacy environment hook replace OAuth auth.
    if (process.env.ANTHROPIC_CUSTOM_HEADERS?.split("\n").some((line) => /^\s*authorization\s*:/i.test(line))) {
      throw new Error("custom anthropic authorization headers are unsupported; use /login anthropic for claude code subscription access.");
    }
    if (!(await readClaudeTokens(profile))) throw new Error(`claude profile '${profile}' is not signed in; run /login anthropic ${profile}.`);
    return anthropic(new Anthropic({
      apiKey: null, authToken: null, baseURL: "https://api.anthropic.com",
      credentials: claudeCredentials(profile),
      defaultHeaders: { "anthropic-beta": CLAUDE_BETAS, "x-api-key": null },
      fetchOptions: { redirect: "error" },
    }), { promptCache: options.promptCache ?? (config.anthropicPromptCache === true) });
  }
  if (!(await readCodexTokens(profile))) throw new Error(`codex profile '${profile}' is not signed in; run /login openai ${profile}.`);
  return openai(codexCredentials(profile));
}
