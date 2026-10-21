// Merged PRs: when a branch's PR is merged on GitHub, stop its worker and
// reviewer, clean the branch up and tell the orchestrator with one
// `[agent-exit]` notice, like the cleanup it used to do by hand.
//
// The TUI calls a watcher's check for every open page on each inbox poll; the
// watcher asks `gh pr list --state merged` at most every MERGE_POLL_MS per
// project, one check per project at a time. A merge is handled once, also
// across restarts and with two TUIs open: projects/<id>/merged/<n> is created
// exclusively by whoever handles PR #n (like the run claims in exits.ts).
//
// Order per merged branch: claim the PR, close the agents' current runs (so
// their own crash/signal/exit paths and the watchdog stay silent), kill their
// windows and wait for the processes to go, then clean up (worktree, local
// and remote branch, transcripts, inboxes, runs) unless the worktree has
// uncommitted changes, pull main, and notify.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { open as openFile, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";
import { claim, dirtyCount, pidAlive, readRun } from "./exits";
import { put } from "./inbox";
import { removeWorktree, sessionName, slug, tmux } from "./runner";

export interface MergedPR {
  number: number;
  headRefName: string;
  url: string;
  mergedAt: string;
}

/** How often each project's merged PRs are listed. */
export const MERGE_POLL_MS = 30_000;
/** How long `gh` may take before it is killed and the check skipped. */
const GH_TIMEOUT_MS = 20_000;
/** Git commands that touch the network (push --delete, pull). */
const GIT_NET_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;
/** How long to wait for killed agents' processes to exit. */
const STOP_WAIT_MS = 5_000;
/** Branches never touched, whatever a PR says. */
const PROTECTED = new Set(["main", "master", "HEAD"]);
const ROLES = ["worker", "reviewer"] as const;

const quietEnv = () => ({ ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" });

/** Run argv in cwd with a hard timeout; null when it could not start or timed out. */
async function exec(argv: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string; err: string } | null> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, { cwd, env: quietEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return timedOut ? null : { code, out, err };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const isPR = (p: unknown): p is MergedPR => {
  const r = p as MergedPR;
  return !!r && typeof r.number === "number" && Number.isInteger(r.number) && r.number > 0 && typeof r.headRefName === "string" && r.headRefName !== "" && typeof r.url === "string";
};

/** The repo's merged PRs via `gh`, or null when gh is missing, fails, times out or prints something else. */
export async function ghMerged(cwd: string, opts: { bin?: string; timeoutMs?: number } = {}): Promise<MergedPR[] | null> {
  const bin = opts.bin ?? Bun.which("gh");
  if (!bin || !existsSync(cwd)) return null;
  const res = await exec([bin, "pr", "list", "--state", "merged", "--json", "number,headRefName,url,mergedAt"], cwd, opts.timeoutMs ?? GH_TIMEOUT_MS);
  if (!res || res.code !== 0) return null;
  try {
    const list: unknown = JSON.parse(res.out);
    return Array.isArray(list) ? list.filter(isPR) : null;
  } catch {
    return null;
  }
}

export interface MergeWatchOptions {
  /** Merged PRs of the repo at `cwd`, null on any failure; tests inject a fake. */
  gh?: (cwd: string) => Promise<MergedPR[] | null>;
  /** Live agent windows, or null when tmux could not be asked (then the check is skipped). */
  live: (project: string) => Promise<string[] | null>;
  /** Close an agent window. */
  kill?: (project: string, window: string) => Promise<void>;
  alive?: (pid: number) => boolean;
  dirty?: (cwd: string) => Promise<number | null>;
  now?: () => number;
  /** Minimum time between two gh calls for one project (MERGE_POLL_MS). */
  everyMs?: number;
  /** How long to wait for killed agents to exit (STOP_WAIT_MS). */
  waitMs?: number;
}

type Deps = Required<Omit<MergeWatchOptions, "now" | "everyMs">>;

const mergedDir = (project: string) => join(paths.project(project), "merged");
const ids = (s: string) => ROLES.map((r) => `${r}-${s}`);

/** Exclusively create merged/<n>: true for the one caller that handles the PR. */
async function claimMerge(project: string, pr: MergedPR, outcome: string): Promise<boolean> {
  mkdirSync(mergedDir(project), { recursive: true });
  try {
    const f = await openFile(join(mergedDir(project), String(pr.number)), "wx");
    await f.writeFile(JSON.stringify({ branch: pr.headRefName, url: pr.url, mergedAt: pr.mergedAt, outcome }) + "\n");
    await f.close();
    return true;
  } catch {
    return false;
  }
}

const handled = (project: string, n: number) => existsSync(join(mergedDir(project), String(n)));

/** runs/ files of these agents: their state and close claims. */
async function runFiles(project: string, agents: string[]): Promise<string[]> {
  const names = await readdir(paths.runs(project)).catch(() => [] as string[]);
  return names.filter((n) => agents.some((id) => n.startsWith(`${id}.`)));
}

/** Whether anything of the branch is still around: worktree, windows, transcripts or runs. */
async function hasState(project: string, s: string, live: string[]): Promise<boolean> {
  const agents = ids(s);
  if (existsSync(paths.worktree(project, s))) return true;
  if (agents.some((id) => live.includes(id) || existsSync(paths.transcript(project, id)))) return true;
  return (await runFiles(project, agents)).length > 0;
}

/**
 * The worktree was made after the merge: the branch name was reused for new
 * work, so this PR is not about it. A worktree's `.git` file is written once,
 * by `git worktree add`.
 */
function reused(project: string, s: string, pr: MergedPR): boolean {
  const merged = Date.parse(pr.mergedAt);
  if (!Number.isFinite(merged)) return false;
  try {
    return statSync(join(paths.worktree(project, s), ".git")).mtimeMs > merged;
  } catch {
    return false;
  }
}

async function currentBranch(repo: string): Promise<string | null> {
  const res = await exec(["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], repo, GIT_TIMEOUT_MS);
  return res?.code === 0 ? res.out.trim() : null;
}

/** Close the agents' current runs, kill their windows, wait for their processes. Returns the agents that were running and whether all are gone. */
async function stopAgents(project: string, s: string, live: string[], d: Deps): Promise<{ running: string[]; gone: boolean }> {
  const agents = ids(s);
  const runs = await Promise.all(agents.map((id) => readRun(project, id)));
  // Deliberate: claim first, so the agents' own exit paths and the watchdog send nothing.
  for (const [i, id] of agents.entries()) if (runs[i]) await claim(project, id, runs[i]!.run);
  const running = agents.filter((id) => live.includes(id));
  for (const id of running) await d.kill(project, id);
  const pids = runs.flatMap((r) => (r ? [r.pid] : []));
  const deadline = Date.now() + d.waitMs;
  while (pids.some((p) => d.alive(p)) && Date.now() < deadline) await Bun.sleep(50);
  return { running, gone: !pids.some((p) => d.alive(p)) };
}

/**
 * Remove the worktree, the local and remote branch, transcripts, inboxes and
 * runs/ files. The close claims of the runs just stopped stay (pruned after a
 * day like any claim), so a late follow-up still finds its run closed; with
 * agents still alive every runs/ file stays. Returns what went wrong.
 */
async function cleanUp(project: string, branch: string, s: string, gone: boolean): Promise<string[]> {
  const repo = paths.repo(project);
  const problems: string[] = [];
  try {
    await removeWorktree(project, branch);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  const local = await exec(["git", "-C", repo, "branch", "-D", "--", branch], repo, GIT_TIMEOUT_MS);
  if (local && local.code !== 0 && !/not found/i.test(local.err)) problems.push(`git branch -D: ${local.err.trim()}`);
  const remote = await exec(["git", "-C", repo, "push", "origin", "--delete", branch], repo, GIT_NET_TIMEOUT_MS);
  if (!remote) problems.push("git push --delete timed out");
  else if (remote.code !== 0 && !/remote ref does not exist|not found/i.test(remote.err)) problems.push(`git push --delete: ${remote.err.trim()}`);
  const agents = ids(s);
  for (const id of agents) {
    await rm(paths.transcript(project, id), { force: true }).catch(() => {});
    await rm(join(paths.inbox(project), id), { recursive: true, force: true }).catch(() => {});
  }
  if (gone) {
    const keep = new Set((await Promise.all(agents.map((id) => readRun(project, id)))).flatMap((r, i) => (r ? [`${agents[i]}.${r.run}.exit`] : [])));
    for (const n of await runFiles(project, agents)) if (!keep.has(n)) await unlink(join(paths.runs(project), n)).catch(() => {});
  }
  return problems.map((p) => p.replace(/\s+/g, " ").slice(0, 200));
}

/** The notice for one merged branch. */
export function mergeNotice(pr: MergedPR, running: string[], outcome: { dirty: number | null; problems?: string[]; alive?: boolean }): string {
  const who = running.length ? `${running.join(", ")} stopped` : `no agents running on ${pr.headRefName}`;
  let tail: string;
  if (outcome.dirty === 0) tail = outcome.problems?.length ? `cleaned up, except: ${outcome.problems.join("; ")}` : "cleaned up";
  else tail = `kept worktree: ${outcome.dirty === null ? "unknown" : outcome.dirty} uncommitted changes`;
  if (outcome.alive) tail += "; an agent process is still exiting";
  return `[agent-exit] ${who}: PR #${pr.number} merged (${pr.url}); ${tail}`;
}

/** Handle one merged PR: stop, clean up, notify. False when there was nothing to do or another watcher has it. */
async function handleMerge(project: string, pr: MergedPR, live: string[], d: Deps): Promise<boolean> {
  const branch = pr.headRefName;
  const s = slug(branch);
  if (!(await hasState(project, s, live))) {
    // Nothing of it here: mark it seen, so a later branch of the same name is never taken for it.
    await claimMerge(project, pr, "nothing to do");
    return false;
  }
  if (reused(project, s, pr)) {
    await claimMerge(project, pr, "branch reused after the merge");
    return false;
  }
  if (!(await claimMerge(project, pr, "handled"))) return false;
  try {
    const { running, gone } = await stopAgents(project, s, live, d);
    const wt = paths.worktree(project, s);
    const dirty = existsSync(wt) ? await d.dirty(wt) : 0;
    const problems = dirty === 0 ? await cleanUp(project, branch, s, gone) : [];
    const repo = paths.repo(project);
    await exec(["git", "-C", repo, "pull", "--ff-only", "--quiet"], repo, GIT_NET_TIMEOUT_MS);
    await put(project, "orchestrator", { from: running[0] ?? `worker-${s}`, text: mergeNotice(pr, running, { dirty, problems, alive: !gone }) });
    return true;
  } catch (err) {
    // Let a later check try again.
    await unlink(join(mergedDir(project), String(pr.number))).catch(() => {});
    throw err;
  }
}

/** The merged PRs that may need handling: not handled yet, not a protected branch. */
async function candidates(project: string, prs: MergedPR[]): Promise<MergedPR[]> {
  const open = prs.filter((pr) => !handled(project, pr.number) && !PROTECTED.has(pr.headRefName));
  if (!open.length) return [];
  const head = await currentBranch(paths.repo(project));
  return open.filter((pr) => pr.headRefName !== head);
}

/**
 * The TUI's merge watcher: `check(project)` lists merged PRs at most every
 * `everyMs` per project, one check per project at a time, and handles each
 * merged branch that still has a worktree, agent windows, transcripts or runs.
 * gh or tmux failing skips the check quietly; it is retried later. Returns the
 * PR numbers handled.
 */
export function mergeWatcher(opts: MergeWatchOptions) {
  const d: Deps = {
    gh: opts.gh ?? ((cwd) => ghMerged(cwd)),
    live: opts.live,
    kill: opts.kill ?? ((project, window) => tmux.killWindow(sessionName(project), window)),
    alive: opts.alive ?? pidAlive,
    dirty: opts.dirty ?? ((cwd) => dirtyCount(cwd)),
    waitMs: opts.waitMs ?? STOP_WAIT_MS,
  };
  const now = opts.now ?? Date.now;
  const every = opts.everyMs ?? MERGE_POLL_MS;
  const last = new Map<string, number>();
  const busy = new Set<string>();
  return async function check(project: string): Promise<number[]> {
    if (busy.has(project)) return [];
    const t = now();
    if (t - (last.get(project) ?? -Infinity) < every) return [];
    busy.add(project);
    last.set(project, t);
    try {
      const prs = await d.gh(paths.repo(project)).catch(() => null);
      if (!prs) return [];
      const todo = await candidates(project, prs);
      if (!todo.length) return [];
      const live = await d.live(project).catch(() => null);
      if (live === null) return [];
      const done: number[] = [];
      for (const pr of todo) if (await handleMerge(project, pr, live, d).catch(() => false)) done.push(pr.number);
      return done;
    } finally {
      busy.delete(project);
    }
  };
}
