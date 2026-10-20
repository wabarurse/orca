// Which providers are signed in, and how. Anthropic uses the `ant` CLI's OAuth
// profile (or ANTHROPIC_API_KEY). OpenAI has no OAuth for third-party tools,
// so it is an API key: OPENAI_API_KEY, or one saved here with mode 0600.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { existsSync, readdirSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { paths } from "./config";
import { anthropic } from "./providers/anthropic";
import type { Provider, ProviderName } from "./providers/index";
import { openai } from "./providers/openai";

export interface Account {
  provider: ProviderName;
  /** Signed in and usable. */
  ok: boolean;
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

function anthropicProfile(): string | null {
  const dir = process.env.ANTHROPIC_CONFIG_DIR ?? join(homedir(), ".config", "anthropic");
  const creds = join(dir, "credentials");
  if (!existsSync(creds)) return null;
  const files = readdirSync(creds).filter((f) => f.endsWith(".json"));
  return files.length ? files.map((f) => f.slice(0, -5)).join(", ") : null;
}

export async function accounts(): Promise<Account[]> {
  const profile = anthropicProfile();
  const anth: Account = process.env.ANTHROPIC_API_KEY
    ? { provider: "anthropic", ok: true, source: "ANTHROPIC_API_KEY" }
    : profile
      ? { provider: "anthropic", ok: true, source: `ant auth login (profile: ${profile})` }
      : { provider: "anthropic", ok: false, source: "not signed in; /login anthropic" };
  const key = await openaiKey();
  const oai: Account = process.env.OPENAI_API_KEY
    ? { provider: "openai", ok: true, source: "OPENAI_API_KEY" }
    : key
      ? { provider: "openai", ok: true, source: "saved key (~/.parallels/credentials.json)" }
      : { provider: "openai", ok: false, source: "not signed in; /login openai" };
  return [anth, oai];
}

export async function provider(name: ProviderName): Promise<Provider> {
  if (name === "anthropic") return anthropic(new Anthropic());
  const apiKey = await openaiKey();
  if (!apiKey) throw new Error("openai: not signed in; run /login openai or set OPENAI_API_KEY");
  return openai(new OpenAI({ apiKey }));
}
