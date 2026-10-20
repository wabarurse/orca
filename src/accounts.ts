// Named Claude subscription logins, plus explicit Anthropic/OpenAI API keys.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_BETAS, claudeCredentials, claudeProfiles, readClaudeTokens, validateProfile } from "./claude-auth";
import { loadConfig, paths } from "./config";
import { anthropic } from "./providers/anthropic";
import type { Provider, ProviderName } from "./providers/index";
import { openai } from "./providers/openai";

export interface Account {
  /** "anthropic:<profile>" or "openai". */
  id: string;
  provider: ProviderName;
  /** Signed in and usable. */
  ok: boolean;
  /** Tokens are pulled from this one right now. */
  active: boolean;
  /** Where the credential comes from, for display. */
  source: string;
}

const credentialsPath = () => join(paths.root, "credentials.json");

async function saved(): Promise<Record<string, string>> {
  const f = Bun.file(credentialsPath());
  return (await f.exists()) ? ((await f.json()) as Record<string, string>) : {};
}

export async function saveKey(provider: ProviderName, key: string): Promise<void> {
  const all = { ...(await saved()), [provider]: key };
  await Bun.write(credentialsPath(), JSON.stringify(all, null, 2) + "\n");
  await chmod(credentialsPath(), 0o600);
}

export async function openaiKey(): Promise<string | undefined> {
  return process.env.OPENAI_API_KEY || (await saved()).openai;
}

export const anthropicProfiles = claudeProfiles;

/** Profile selection is local to parallels; `ant` org/workspace profiles are never used. */
export const activeProfile = (configured: string) => validateProfile(configured || "default");

export async function accounts(): Promise<Account[]> {
  const { account } = await loadConfig();
  const out: Account[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    out.push({ id: "anthropic:env", provider: "anthropic", ok: true, active: true, source: "ANTHROPIC_API_KEY — API billing (overrides subscription profiles)" });
  }
  const profiles = anthropicProfiles();
  const active = activeProfile(account);
  for (const p of profiles) {
    const ok = await readClaudeTokens(p).then(Boolean).catch(() => false);
    out.push({ id: `anthropic:${p}`, provider: "anthropic", ok, active: ok && !process.env.ANTHROPIC_API_KEY && p === active, source: ok ? "Claude subscription OAuth" : `invalid credentials; /login anthropic ${p}` });
  }
  if (!profiles.includes(active) && !process.env.ANTHROPIC_API_KEY) {
    out.push({ id: `anthropic:${active}`, provider: "anthropic", ok: false, active: false, source: `not signed in; /login anthropic ${active}` });
  }
  const key = await openaiKey();
  out.push(
    process.env.OPENAI_API_KEY
      ? { id: "openai", provider: "openai", ok: true, active: true, source: "OPENAI_API_KEY" }
      : key
        ? { id: "openai", provider: "openai", ok: true, active: true, source: "saved key (~/.parallels/credentials.json)" }
        : { id: "openai", provider: "openai", ok: false, active: false, source: "not signed in; /login openai" },
  );
  return out;
}

export async function provider(name: ProviderName): Promise<Provider> {
  if (name === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) {
      return anthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, authToken: null }));
    }
    const { account } = await loadConfig();
    const profile = activeProfile(account);
    if (!(await readClaudeTokens(profile))) throw new Error(`Claude profile '${profile}' is not signed in; run /login anthropic ${profile}.`);
    return anthropic(new Anthropic({
      apiKey: null,
      authToken: null,
      baseURL: "https://api.anthropic.com",
      credentials: claudeCredentials(profile),
      defaultHeaders: { "anthropic-beta": CLAUDE_BETAS },
    }), { subscription: true });
  }
  const apiKey = await openaiKey();
  if (!apiKey) throw new Error("openai: not signed in; run /login openai or set OPENAI_API_KEY");
  return openai(new OpenAI({ apiKey }));
}
