// /accounts and /login: listing, switching and signing in to subscription accounts.

import { accounts, type Account } from "../../login/accounts";
import { importClaudeCode, loginClaude } from "../../login/claude";
import { importCodex, loginCodex } from "../../login/codex";
import { saveConfig } from "../../config/config";
import type { Choice } from "./model";

export async function accountChoices(dim: (s: string) => string): Promise<Choice<Account>[]> {
  return (await accounts()).map((a) => ({ value: a, current: a.active, label: `${a.ok ? "○" : "✗"} ${a.id.padEnd(22)} ${dim(a.source)}` }));
}

/** Make a signed-in account the one its provider uses from the next turn on. */
export async function useAccount(account: Account): Promise<string> {
  const profile = account.id.split(":")[1]!;
  await saveConfig(account.provider === "anthropic" ? { account: profile } : { openaiAccount: profile });
  return `using ${account.id} (takes effect next turn; running agents keep theirs)`;
}

export const LOGIN_USAGE = "usage: /login anthropic [profile] [--from-claude-code]  |  /login openai [profile] [--from-codex]";

/** `/login <provider> [profile] [--from-...]`; returns what to tell the user, or throws. */
export async function login(arg: string, io: { write: (s: string) => void; signal: AbortSignal }): Promise<string> {
  const [alias = "", ...args] = arg.split(/\s+/).filter(Boolean);
  const name = alias === "claude" ? "anthropic" : alias === "codex" ? "openai" : alias;
  if (name !== "anthropic" && name !== "openai") return LOGIN_USAGE;
  const importFlag = name === "anthropic" ? "--from-claude-code" : "--from-codex";
  const names = args.filter((a) => a !== importFlag);
  if (names.length > 1 || names.some((n) => n.startsWith("--"))) return `usage: /login ${name} [profile] [${importFlag}]`;
  const profile = names[0] ?? "default";
  if (args.includes(importFlag)) await (name === "anthropic" ? importClaudeCode : importCodex)(profile);
  else await (name === "anthropic" ? loginClaude : loginCodex)(profile, io);
  await saveConfig(name === "anthropic" ? { account: profile } : { openaiAccount: profile });
  return `signed in; now using ${name}:${profile} (${name === "anthropic" ? "claude code / claude subscription" : "codex / chatgpt subscription"})`;
}
