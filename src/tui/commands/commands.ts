import { readRun } from "../../core/tmux/exits";
import { describeOwner, lockOwner, tryStorageLock } from "../../core/data/storage-lock";
import { conversationTurnLock, projectIdentity, withProjectStateLock } from "../../core/data/projects/state";
import { effectiveModel, saveProjectModel, validateModel } from "../../core/data/projects/project-model";
import { effectiveFlow, saveProjectFlow } from "../../core/data/projects/flow";
// What the slash commands do, apart from how they are shown. The TUI turns
// these into menus and status lines.

import { existsSync, realpathSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { $ } from "bun";
import { accounts, provider, type Account } from "../../login/accounts";
import { importClaudeCode, loginClaude } from "../../login/claude";
import { importCodex, loginCodex } from "../../login/codex";
import { loadConfig, paths, saveConfig, validRounds, MAX_REVIEW_ROUNDS } from "../../config/config";
import { checkoutHere, removeProjectWorktrees } from "../../core/data/projects/workspace";
import { purgeProject } from "../../core/data/memory/archive";
import { watchdog } from "../../core/tmux/exits";
import { mergeWatcher } from "../../core/tmux/merges";
import { providerFor, type ProviderName } from "../../providers/index";
import { modelCapabilities } from "../../providers/catalog/capabilities";
import { prefetchContextLimits } from "../../providers/catalog/context-window";
import { effectiveSettingsReport } from "../../core/data/projects/project-settings";
import { sessionName, tmux } from "../../core/tmux/runner";
import { stopDaemon } from "../../core/agent-loop/orc/client";

export interface Choice<T> { value: T; label: string; current?: boolean }

/** How many of each provider's newest models /model offers. */
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
 * A live agent has no end; if its state already has one, that state is a previous run's
 * (a respawn before beginRun) or a run mid-close, so there is no clock. A finished one without endedAt gets the run file's
 * last update, marked approximate; without startedAt, the transcript's first entry.
 */
async function agentTimes(project: string, name: string, live: boolean): Promise<Pick<AgentInfo, "startedAt" | "endedAt" | "approximateEnd">> {
  const state = await readRun(project, name);
  if (live && state?.endedAt) return {};
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

/** The worker/reviewer windows among a tmux session's windows: all but the idle shell and the orchestrator daemon's. */
export const agentWindows = (windows: string[]) => windows.filter((w) => w !== "shell" && w !== "orchestrator");

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
 * The exit watchdog (src/core/tmux/exits.ts), run by the orchestrator daemon on its
 * poll: agents that stopped without reporting or sending their own
 * notice get an `[agent-exit]` notice. `live` is stubbed in tests.
 */
export const exitWatchdog = (live: (project: string) => Promise<string[] | null> = liveAgentsOrNull) => watchdog({ live });

/**
 * The merge watcher (src/core/tmux/merges.ts), run by the orchestrator daemon on its
 * poll next to the exit watchdog; it asks gh about every 30s per project.
 */
export const mergeWatch = (live: (project: string) => Promise<string[] | null> = liveAgentsOrNull) => mergeWatcher({ live });

/** Close a project's (now idle) tmux session, if tmux is installed. */
export async function killProjectSession(project: string): Promise<void> {
  if (Bun.which("tmux")) await tmux.killSession(sessionName(project));
}

export interface DeleteOptions {
  /** Live agent windows; defaults to the tmux session's. Tests replace it. */
  live?: (project: string) => Promise<string[] | null>;
  /** Stop the project's orchestrator daemon and wait for it (orchestrator-client.ts stopDaemon); tests replace it. */
  stop?: (project: string) => Promise<void>;
  /** Close the project's idle tmux session; defaults to killProjectSession. Tests replace it. */
  kill?: (project: string) => Promise<void>;
  /** Runs once the checks pass, before anything is removed (the TUI closes the project's page here). */
  beforeRemove?: () => Promise<void> | void;
}

/**
 * Delete project state and clean managed worktrees, preserving an original
 * checkout. Legacy clones retain their old deletion behavior. Refused while agents run. Stops
 * the orchestrator daemon, then drops the project from the pins and closes its tmux session.
 */
export async function deleteProject(name: string, { live = liveAgentsOrNull, stop = stopDaemon, kill = killProjectSession, beforeRemove }: DeleteOptions = {}): Promise<void> {
  if (!validProjectName(name)) throw new Error(`not a project name: ${name}`);
  if (!existsSync(paths.project(name))) throw new Error(`no project named ${name}`);
  // Only this conversation's own turn must be excluded, not the checkout-wide one a
  // sibling conversation (Ctrl+N) holds mid-turn: deletion never touches the shared
  // checkout's files, and the worktrees it unregisters are in this project's own
  // namespace, serialised by git itself like the worker worktree add/remove that
  // already runs during sibling turns without the turn lock.
  const lock = conversationTurnLock(name);
  const release = await tryStorageLock(lock, name);
  if (!release) {
    const owner = await lockOwner(lock);
    throw new Error(owner
      ? `${name} orchestrator is mid-turn in another session (${describeOwner(owner)}); wait for that turn to end, then delete`
      : `${name} turn lock ${lock} is held by an unknown owner; verify no orca process is using ${name}, remove the lock, then delete`);
  }
  try {
    const agents = await live(name);
    if (agents === null) throw new Error("cannot check live agents; project was not deleted");
    if (agents.length) throw new Error(`${name} still has live agents (${agents.join(", ")}); wait for them or stop them first`);
    await stop(name); // the daemon must be gone before its files are, or it writes them back
    await kill(name);
    await withProjectStateLock(name, async () => {
      await removeProjectWorktrees(name);
      await beforeRemove?.();
      await rm(paths.project(name), { recursive: true, force: true });
      // Best effort: the project is already gone, and the backfill's orphan cleanup removes leftovers.
      try { purgeProject(name); } catch { /* rebuildable index */ }
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

/** Effort picker choices for the project's current model: "default" plus the levels it supports, current marked.
 * Levels come from the provider catalog (fetched once per process, like context limits) and fall back to the
 * built-in table. `note` explains a saved effort the current list lacks (used as default, kept on disk). */
export async function effortChoices(project: string, load: typeof provider = provider): Promise<{ choices: Choice<string>[]; model: string; current: string; note?: string }> {
  const model = await effectiveModel(project);
  try { await prefetchContextLimits(await load(providerFor(model))); } catch { /* no account/catalog: built-in levels */ }
  const { settings, dropped } = await effectiveSettingsReport(project, model);
  const current = settings.effort ?? "default";
  const choices = ["default", ...modelCapabilities(model).effort].map((value) => ({ value, label: value, current: value === current }));
  return { choices, model, current, ...(dropped ? { note: `saved effort ${dropped} is not supported for ${model} by the current capability list; requests use the default until another level is chosen` } : {}) };
}

export async function setModel(id: string, project?: string, identity?: string): Promise<string> {
  validateModel(id);
  if (project) await saveProjectModel(project, id, identity);
  else await saveConfig({ model: id }); // Retain the programmatic global-default API.
  return `model set to ${id} (applies before each agent’s next model request; running tools finish; failed/stopped turns need another message to resume; exited agents require restart)`;
}

export const REVIEW_ROUNDS_USAGE = `usage: /review-rounds [n]  (n = 0 to ${MAX_REVIEW_ROUNDS}; 0 skips review and goes straight to ci)`;

/** `/review-rounds [n]`: show the project's review round limit, or save it for this project. */
export async function reviewRounds(project: string, arg: string): Promise<string> {
  const identity = projectIdentity(project);
  if (!arg) return `review rounds: ${(await effectiveFlow(project)).maxReviewRounds}`;
  const n = /^\d{1,3}$/.test(arg) ? Number(arg) : NaN;
  if (!validRounds(n)) return REVIEW_ROUNDS_USAGE;
  await saveProjectFlow(project, { maxReviewRounds: n }, identity);
  return `review rounds set to ${n} for this project; applies from the orchestrator's next turn`;
}

export const DYNAMIC_DISPATCH_USAGE = "usage: /dynamic-dispatch [on|off]";

/** `/dynamic-dispatch [on|off]`: show the project's switch, or save it for this project. */
export async function dynamicDispatch(project: string, arg: string): Promise<string> {
  const identity = projectIdentity(project);
  if (!arg) return `dynamic dispatch: ${(await effectiveFlow(project)).dynamicDispatch ? "on" : "off"}`;
  if (arg !== "on" && arg !== "off") return DYNAMIC_DISPATCH_USAGE;
  await saveProjectFlow(project, { dynamicDispatch: arg === "on" }, identity);
  return `dynamic dispatch set to ${arg} for this project; applies from the orchestrator's next turn`;
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
