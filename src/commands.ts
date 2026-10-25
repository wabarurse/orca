import { readRun } from "./exits";
import { tryStorageLock } from "./storage-lock";
import { projectTurnLock, withProjectStateLock } from "./project-state";
import { effectiveModel, saveProjectModel, validateModel } from "./project-model";
// What the slash commands do, apart from how they are shown. The TUI turns
// these into menus and status lines.

import { existsSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { $ } from "bun";
import { accounts, provider, type Account } from "./accounts";
import { importClaudeCode, loginClaude } from "./claude-auth";
import { importCodex, loginCodex } from "./codex-auth";
import { loadConfig, paths, saveConfig, validRounds, MAX_REVIEW_ROUNDS } from "./config";
import { checkoutHere, removeProjectWorktrees } from "./workspace";
import { watchdog } from "./exits";
import { mergeWatcher } from "./merges";
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

/** One /agents row: the agent, whether its window is live, and its latest run's times. */
export interface AgentInfo {
  name: string;
  live: boolean;
  /** ISO start of the latest run. */
  startedAt?: string;
  /** ISO end of that run; absent while it is live. */
  endedAt?: string;
  /** endedAt is the run state's last update, not a recorded end (the agent was killed hard). */
  approximateEnd?: boolean;
}

/** The first transcript entry's ts: read from the file's first line only. */
async function firstEntryTs(path: string): Promise<string | undefined> {
  try {
    const head = await Bun.file(path).slice(0, 8192).text();
    const ts = (JSON.parse(head.split("\n")[0]!) as { ts?: unknown }).ts;
    return typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The latest run's times for agent `name` (its run file id is its transcript id).
 * A live agent has no end. A finished one without endedAt gets the run file's
 * last update, marked approximate; without startedAt, the transcript's first entry.
 */
async function agentTimes(project: string, name: string, live: boolean): Promise<Pick<AgentInfo, "startedAt" | "endedAt" | "approximateEnd">> {
  const state = await readRun(project, name);
  const startedAt = state?.startedAt ?? (await firstEntryTs(paths.transcript(project, name)));
  if (!startedAt) return {};
  if (live) return { startedAt };
  if (state?.endedAt) return { startedAt, endedAt: state.endedAt };
  return state?.ts ? { startedAt, endedAt: state.ts, approximateEnd: true } : { startedAt };
}

/** Every agent that has a transcript, marked live when its tmux window is still open, with its latest run's times. */
export async function listAgents(project: string): Promise<AgentInfo[]> {
  const live = new Set(await liveAgents(project));
  const dir = paths.transcript(project, "x").replace(/x\.jsonl$/, "");
  const names = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
  return Promise.all(names.filter((n) => n !== "orchestrator").map(async (name) => ({ name, live: live.has(name), ...(await agentTimes(project, name, live.has(name))) })));
}

/** A fresh orchestrator name, orch-xxxx, that no project uses yet. */
export function newProjectName(taken: string[], random: () => number = Math.random): string {
  for (;;) {
    const name = `orch-${random().toString(36).slice(2, 6).padEnd(4, "0")}`;
    if (!taken.includes(name)) return name;
  }
}

export const validProjectName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

/** What the TUI calls a project (status line, project list): its /rename name, else its id. */
export async function displayName(project: string): Promise<string> {
  const file = Bun.file(paths.displayName(project));
  const name = (await file.exists()) ? (await file.text()).trim() : "";
  return name || project;
}

/**
 * Give a project a display name. Only the name file changes: the folder, the
 * id, the tmux session and running agents stay as they are, so this is safe
 * at any time. Refused when another project already shows that name.
 */
export async function setDisplayName(project: string, name: string): Promise<string> {
  name = name.trim();
  if (!name || name.length > 40 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(name)) throw new Error("names are 1-40 printable characters");
  for (const other of await listProjects()) {
    if (other !== project && (other === name || (await displayName(other)) === name)) throw new Error(`another project is already called ${name}`);
  }
  await Bun.write(paths.displayName(project), name + "\n");
  return name;
}

/** A project's origin URL, or "no remote". */
export async function remoteOf(project: string): Promise<string> {
  const res = await $`git -C ${paths.repo(project)} remote get-url origin`.quiet().nothrow();
  return res.exitCode === 0 ? res.stdout.toString().trim() : "no remote";
}

/** Original checkout path, even when origin exists; null outside a repository. */
export async function repoHere(cwd = process.cwd()): Promise<string | null> {
  return checkoutHere(cwd);
}

/** Reuse by canonical checkout identity, never by a shared remote URL. */
export async function projectFor(directory: string): Promise<string | null> {
  const source = await checkoutHere(directory);
  if (!source) return null;
  for (const name of await listProjects()) {
    if (existsSync(paths.repo(name)) && realpathSync(paths.repo(name)) === source) return name;
  }
  return null;
}

/** A clone source for people: no scheme, no .git, home as ~. */
export function shortRemote(url: string): string {
  return url.replace(/^[a-z+]+:\/\//, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git$/, "").replace(homedir(), "~");
}

/** Keep unavailable bound checkouts listed so their conversations remain discoverable. */
export async function listProjects(): Promise<string[]> {
  const names = await readdir(paths.project("x").replace(/x$/, "")).catch(() => [] as string[]);
  const out: string[] = [];
  for (const name of names.sort()) if (existsSync(paths.repository(name)) || existsSync(paths.repo(name))) out.push(name);
  return out;
}

// --- the project list ------------------------------------------------------------

/** A project in the list: its id (folder, pins, delete) and the label it shows (its display name). */
export interface ProjectEntry { name: string; label: string; pinned: boolean }

/** Pinned projects first, then the rest, each sorted by label (then id). Pins without a project are dropped. */
export function orderProjects(projects: { name: string; label: string }[], pinned: string[]): ProjectEntry[] {
  const pins = new Set(pinned);
  const byLabel = (a: { name: string; label: string }, b: { name: string; label: string }) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name);
  const sorted = [...new Map(projects.map((p) => [p.name, p])).values()].sort(byLabel);
  return [...sorted.filter((p) => pins.has(p.name)), ...sorted.filter((p) => !pins.has(p.name))].map((p) => ({ ...p, pinned: pins.has(p.name) }));
}

/** Every project for the project list (Ctrl+B, /projects), pinned first, labelled with its display name. */
export async function orderedProjects(): Promise<ProjectEntry[]> {
  const projects = await Promise.all((await listProjects()).map(async (name) => ({ name, label: await displayName(name) })));
  return orderProjects(projects, (await loadConfig()).pinned);
}

/** Pin or unpin a project in config.toml; returns whether it is pinned now. */
export async function togglePin(name: string): Promise<boolean> {
  const { pinned } = await loadConfig();
  const on = !pinned.includes(name);
  await saveConfig({ pinned: on ? [...pinned, name] : pinned.filter((n) => n !== name) });
  return on;
}

/** The agent windows among a tmux session's windows: all but the session's idle shell. */
export const agentWindows = (windows: string[]) => windows.filter((w) => w !== "shell");

/** Agent windows still open in a project's tmux session; read from tmux alone, without transcripts. */
export async function liveAgents(project: string): Promise<string[]> {
  return agentWindows(await tmux.listWindows(sessionName(project)).catch(() => [] as string[]));
}

/** Like liveAgents, but null when tmux could not be asked, so the watchdog never mistakes an error for "all gone". */
export async function liveAgentsOrNull(project: string): Promise<string[] | null> {
  const windows = await tmux.windows(sessionName(project)).catch(() => null);
  return windows && agentWindows(windows);
}

/**
 * The TUI's exit watchdog (src/exits.ts), checked for every open page on each
 * inbox poll: agents that stopped without reporting or sending their own
 * notice get an `[agent-exit]` notice. `live` is stubbed in tests.
 */
export const exitWatchdog = (live: (project: string) => Promise<string[] | null> = liveAgentsOrNull) => watchdog({ live });

/**
 * The TUI's merge watcher (src/merges.ts), checked for every open page on each
 * inbox poll next to the exit watchdog; it asks gh about every 30s per project.
 */
export const mergeWatch = (live: (project: string) => Promise<string[] | null> = liveAgentsOrNull) => mergeWatcher({ live });

/** Close a project's (now idle) tmux session, if tmux is installed. */
export async function killProjectSession(project: string): Promise<void> {
  if (Bun.which("tmux")) await tmux.killSession(sessionName(project));
}

export interface DeleteOptions {
  /** Live agent windows; defaults to the tmux session's. Tests replace it. */
  live?: (project: string) => Promise<string[] | null>;
  /** Close the project's idle tmux session; defaults to killProjectSession. Tests replace it. */
  kill?: (project: string) => Promise<void>;
  /** Runs once the checks pass, before anything is removed (the TUI closes the project's page here). */
  beforeRemove?: () => Promise<void> | void;
}

/**
 * Delete project state and clean managed worktrees, preserving an original
 * checkout. Legacy clones retain their old deletion behavior. Refused while agents run. Also
 * drops it from the pins and closes its idle tmux session.
 */
export async function deleteProject(name: string, opts: DeleteOptions = {}): Promise<void> {
  if (!validProjectName(name)) throw new Error(`not a project name: ${name}`);
  if (!existsSync(paths.project(name))) throw new Error(`no project named ${name}`);
  const release = await tryStorageLock(projectTurnLock(name));
  if (!release) throw new Error(`${name} orchestrator is running in another session; wait before deleting`);
  try {
    const live = await (opts.live ?? liveAgentsOrNull)(name);
    if (live === null) throw new Error("cannot check live agents; project was not deleted");
    if (live.length) throw new Error(`${name} still has live agents (${live.join(", ")}); wait for them or stop them first`);
    await (opts.kill ?? killProjectSession)(name);
    await withProjectStateLock(name, async () => {
      await removeProjectWorktrees(name);
      await opts.beforeRemove?.();
      await rm(paths.project(name), { recursive: true, force: true });
    });
    const { pinned } = await loadConfig();
    if (pinned.includes(name)) await saveConfig({ pinned: pinned.filter((n) => n !== name) });
  } finally { await release(); }
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
export async function modelChoices(dim: (s: string) => string, project?: string): Promise<{ choices: Choice<string>[]; errors: string[]; current: string }> {
  const model = project ? await effectiveModel(project) : (await loadConfig()).model;
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

export async function setModel(id: string, project?: string, identity?: string): Promise<string> {
  validateModel(id);
  if (project) await saveProjectModel(project, id, identity);
  else await saveConfig({ model: id }); // Retain the programmatic global-default API.
  return `model set to ${id} (applies before each agent’s next model request; running tools finish; failed/stopped turns need another message to resume; exited agents require restart)`;
}

export const REVIEW_ROUNDS_USAGE = `usage: /review-rounds [n]  (n = 0 to ${MAX_REVIEW_ROUNDS}; 0 skips review and goes straight to ci)`;

/** `/review-rounds [n]`: show the review round limit, or save it. */
export async function reviewRounds(arg: string): Promise<string> {
  if (!arg) return `review rounds: ${(await loadConfig()).maxReviewRounds}`;
  const n = /^\d{1,3}$/.test(arg) ? Number(arg) : NaN;
  if (!validRounds(n)) return REVIEW_ROUNDS_USAGE;
  await saveConfig({ maxReviewRounds: n });
  return `review rounds set to ${n} (takes effect from the orchestrator's next turn)`;
}

export const DYNAMIC_DISPATCH_USAGE = "usage: /dynamic-dispatch [on|off]";

/** `/dynamic-dispatch [on|off]`: show the global switch, or save it. */
export async function dynamicDispatch(arg: string): Promise<string> {
  if (!arg) return `dynamic dispatch: ${(await loadConfig()).dynamicDispatch ? "on" : "off"}`;
  if (arg !== "on" && arg !== "off") return DYNAMIC_DISPATCH_USAGE;
  await saveConfig({ dynamicDispatch: arg === "on" });
  return `dynamic dispatch set to ${arg} (takes effect from the orchestrator's next turn)`;
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
