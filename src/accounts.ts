// Which accounts are signed in, and which one tokens come from. Anthropic
// accounts are `ant auth login --profile <name>` profiles (any number; each
// is its own org/workspace and token). OpenAI has no OAuth for third-party
// tools, so it is one API key: OPENAI_API_KEY, or one saved here with mode 0600.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

const anthropicDir = () => process.env.ANTHROPIC_CONFIG_DIR ?? join(homedir(), ".config", "anthropic");

/** Every profile `ant auth login` has stored. */
export function anthropicProfiles(): string[] {
  const creds = join(anthropicDir(), "credentials");
  if (!existsSync(creds)) return [];
  return readdirSync(creds).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

/** The profile tokens come from: config `account`, else ANTHROPIC_PROFILE, else ant's active_config. */
export function activeProfile(configured: string): string | null {
  if (configured) return configured;
  if (process.env.ANTHROPIC_PROFILE) return process.env.ANTHROPIC_PROFILE;
  const f = join(anthropicDir(), "active_config");
  return existsSync(f) ? readFileSync(f, "utf8").trim() || null : null;
}

export async function accounts(): Promise<Account[]> {
  const { account } = await loadConfig();
  const out: Account[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    out.push({ id: "anthropic:env", provider: "anthropic", ok: true, active: true, source: "ANTHROPIC_API_KEY (overrides every profile)" });
  }
  const profiles = anthropicProfiles();
  const active = activeProfile(account);
  for (const p of profiles) {
    out.push({ id: `anthropic:${p}`, provider: "anthropic", ok: true, active: !process.env.ANTHROPIC_API_KEY && p === active, source: `ant profile "${p}"` });
  }
  if (profiles.length === 0 && !process.env.ANTHROPIC_API_KEY) {
    out.push({ id: "anthropic", provider: "anthropic", ok: false, active: false, source: "not signed in; /login anthropic [name]" });
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
    const { account } = await loadConfig();
    // An explicit profile makes a missing one an error instead of silent "no auth".
    return anthropic(new Anthropic(account ? { profile: account } : {}));
  }
  const apiKey = await openaiKey();
  if (!apiKey) throw new Error("openai: not signed in; run /login openai or set OPENAI_API_KEY");
  return openai(new OpenAI({ apiKey }));
}
