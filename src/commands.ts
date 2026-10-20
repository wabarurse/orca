// What the slash commands do, apart from how they are shown. The TUI turns
// these into menus and status lines.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { accounts, provider, type Account } from "./accounts";
import { importClaudeCode, loginClaude } from "./claude-auth";
import { importCodex, loginCodex } from "./codex-auth";
import { loadConfig, paths, saveConfig } from "./config";
import type { ProviderName } from "./providers/index";
import { sessionName, tmux } from "./runner";

export interface Choice<T> { value: T; label: string; current?: boolean }

/** How many of each provider's newest models /models offers. */
export const RECENT_MODELS = 6;

/** The newest `limit` ids, keeping `current` in the list even when it is older. */
export function recentModels(ids: string[], current: string, limit = RECENT_MODELS): string[] {
  const head = ids.slice(0, limit);
  return ids.includes(current) && !head.includes(current) ? [...head, current] : head;
}

/** Every agent that has a transcript, marked live when its tmux window is still open. */
export async function listAgents(project: string): Promise<{ name: string; live: boolean }[]> {
  const live = new Set(await tmux.listWindows(sessionName(project)).catch(() => []));
  const dir = paths.transcript(project, "x").replace(/x\.jsonl$/, "");
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  return names.filter((n) => n !== "orchestrator").map((name) => ({ name, live: live.has(name) }));
}

/** Projects that have been started before: every ~/.parallels/projects/<name> with a repo. */
export async function listProjects(): Promise<string[]> {
  const names = await readdir(paths.project("x").replace(/x$/, "")).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names.sort()) if (existsSync(paths.repo(name))) out.push(name);
  return out;
}

export async function accountChoices(dim: (s: string) => string): Promise<Choice<Account>[]> {
  return (await accounts()).map((a) => ({ value: a, current: a.active, label: `${a.ok ? "○" : "✗"} ${a.id.padEnd(22)} ${dim(a.source)}` }));
}

/** Make a signed-in account the one its provider uses from the next turn on. */
export async function useAccount(account: Account): Promise<string> {
  const profile = account.id.split(":")[1]!;
  await saveConfig(account.provider === "anthropic" ? { account: profile } : { openaiAccount: profile });
  return `using ${account.id} (takes effect next turn; running agents keep theirs)`;
}

/** The newest models of every active provider; errors are reported per provider. */
export async function modelChoices(dim: (s: string) => string): Promise<{ choices: Choice<string>[]; errors: string[]; current: string }> {
  const { model } = await loadConfig();
  const choices: Choice<string>[] = [];
  const errors: string[] = [];
  for (const a of await accounts()) {
    if (!a.active) continue;
    try {
      const ids = await (await provider(a.provider as ProviderName)).models();
      for (const id of recentModels(ids, model)) choices.push({ value: id, current: id === model, label: `${id}  ${dim(a.provider)}` });
    } catch (err) {
      errors.push(`${a.provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { choices, errors, current: model };
}

export async function setModel(id: string): Promise<string> {
  await saveConfig({ model: id });
  return `model set to ${id} (takes effect next turn; running agents keep theirs)`;
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
  return `signed in; now using ${name}:${profile} (${name === "anthropic" ? "Claude Code / Claude subscription" : "Codex / ChatGPT subscription"})`;
}
