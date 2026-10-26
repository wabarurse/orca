// Merged PRs: when a branch's PR is merged on GitHub, stop its worker and
// reviewer, clean the branch up and tell the orchestrator with one
// `[agent-exit]` notice, like the cleanup it used to do by hand.
//
// The orchestrator daemon calls a watcher's check on each poll; the
// watcher asks `gh pr list --repo <origin> --state merged` at most every
// MERGE_POLL_MS per project, one check per project at a time. A merge is
// handled once, also across restarts and with two TUIs open:
// projects/<id>/merged/<n> is created exclusively by whoever handles PR #n
// (like the run claims in exits.ts). It says "started" with the agents that
// were running until the notice is out, then "handled"; a "started" claim
// older than STALE_CLAIM_MS (a crash, or a failed send) is taken over once.
//
// Safety, in order: only GitHub origins, never a PR from a fork, never
// main/master/HEAD, origin's default branch or the checked-out branch. Before
// anything is stopped, the worktree must be on the PR's branch by name and the
// local branch tip must be the PR's head commit or an ancestor of it;
// otherwise everything is kept and the notice says why. After the agents are
// stopped, everything is kept when one of them is still running, a new agent
// started on the branch, or the worktree has uncommitted changes (or the count
// is unknown). Otherwise: worktree, local and remote branch, transcripts,
// inboxes and runs/ files go. `git worktree remove --force` also deletes
// ignored files in the worktree, such as .env.

import { originRepo } from "./github";
export { githubRepo, originRepo } from "./github";
import { archiveMergedTasks, allTasks, blockConflictingTask, observeTaskPR, setTaskAttention, taskPR } from "./tasks";
import { ghTaskPR } from "./github";
import type { PRObservation, Task, TaskPR } from "./tasks";
import { existsSync, linkSync, mkdirSync, statSync } from "node:fs";
import { readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, repositoryBinding } from "./config";
import { claim, dirtyCount, pidAlive, readRun } from "./exits";
import { put } from "./inbox";
import { run, type ProcResult } from "./proc";
import { removeWorktree, sessionName, slug, tmux } from "./runner";

export interface MergedPR {
  number: number;
  headRefName: string;
  url: string;
  mergedAt: string;
  /** The PR's head commit when it was merged. */
  headRefOid: string;
  /** From a fork: its branch is not ours, whatever its name. */
  isCrossRepository: boolean;
}

/** How often each project's merged PRs are listed. */
export const MERGE_POLL_MS = 30_000;
/** A "started" claim older than this was left by a crash or a failed send and is taken over. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** How many of the newest merged PRs gh lists. */
const GH_LIMIT = 100;
const GH_FIELDS = "number,headRefName,url,mergedAt,headRefOid,isCrossRepository";
/** How long `gh` may take before it is killed and the check skipped. */
const GH_TIMEOUT_MS = 20_000;
/** Git commands that touch the network (fetch, push --delete, pull). */
const GIT_NET_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;
/** How long to wait for killed agents' processes to exit. */
const STOP_WAIT_MS = 5_000;
/** Branches never touched, whatever a PR says. */
const PROTECTED = ["main", "master", "HEAD"];
const ROLES = ["worker", "reviewer"] as const;

const quietEnv = () => ({ ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" });
const exec = (argv: string[], cwd: string, timeoutMs: number) => run(argv, { cwd, timeoutMs, env: quietEnv() });
const git = (cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS) => exec(["git", "-C", cwd, ...args], cwd, timeoutMs);
const ok = (r: ProcResult | null) => r?.code === 0;

const isPR = (p: unknown): p is MergedPR => {
  const r = p as MergedPR;
  return !!r && Number.isInteger(r.number) && r.number > 0 && typeof r.headRefName === "string" && r.headRefName !== ""
    && typeof r.mergedAt === "string" && Number.isFinite(Date.parse(r.mergedAt)) && typeof r.url === "string" && typeof r.headRefOid === "string" && /^[0-9a-f]{40,64}$/.test(r.headRefOid) && typeof r.isCrossRepository === "boolean";
};

/** `repo`'s merged PRs via `gh`, or null when gh is missing, fails, times out or prints something else. */
export async function ghMerged(cwd: string, repo: string, opts: { bin?: string; timeoutMs?: number } = {}): Promise<MergedPR[] | null> {
  const bin = opts.bin ?? Bun.which("gh");
  if (!bin || !existsSync(cwd)) return null;
  const argv = [bin, "pr", "list", "--repo", repo, "--state", "merged", "--limit", String(GH_LIMIT), "--json", GH_FIELDS];
  const res = await exec(argv, cwd, opts.timeoutMs ?? GH_TIMEOUT_MS);
  if (!ok(res)) return null;
  try {
    const list: unknown = JSON.parse(res!.out);
    return Array.isArray(list) ? list.filter(isPR) : null;
  } catch {
    return null;
  }
}

export interface MergeWatchOptions {
  /** Merged PRs of GitHub repo `repo` ("owner/name"), run in the clone at `cwd`; null on any failure. Tests inject a fake. */
  gh?: (cwd: string, repo: string) => Promise<MergedPR[] | null>;
  /** The project's origin as "owner/name", null when it is not on GitHub (then nothing is checked). */
  repo?: (project: string) => Promise<string | null>;
  /** Read-only exact PR refresh for registered tasks, including PRs outside the newest-100 merge list. */
  pr?: (project: string, pr: TaskPR) => Promise<PRObservation | null>;
  /** Live agent windows, or null when tmux could not be asked (then the check is skipped). */
  live: (project: string) => Promise<string[] | null>;
  /** Close an agent window. */
  kill?: (project: string, window: string) => Promise<void>;
  alive?: (pid: number) => boolean;
  dirty?: (cwd: string) => Promise<number | null>;
  /** Clock for the poll period. */
  now?: () => number;
  /** Minimum time between two gh calls for one project (MERGE_POLL_MS). */
  everyMs?: number;
  /** How long to wait for killed agents to exit (STOP_WAIT_MS). */
  waitMs?: number;
}

type Deps = Required<Omit<MergeWatchOptions, "now" | "everyMs">>;

interface Watcher {
  d: Deps;
  now: () => number;
  every: number;
  /** When each project was last asked. */
  last: Map<string, number>;
  busy: Set<string>;
  /** origin's default branch per project, once known. */
  defaults: Map<string, string>;
}

const ids = (s: string) => ROLES.map((r) => `${r}-${s}`);

// --- claims: projects/<id>/merged/<n> ------------------------------------------

interface Claim {
  outcome: string;
  ts: string;
  branch: string;
  url: string;
  mergedAt: string;
  /** Agents that were running when the PR was claimed, for the notice. */
  running?: string[];
}

const mergedDir = (project: string) => join(paths.project(project), "merged");
const claimPath = (project: string, n: number) => join(mergedDir(project), String(n));
const claimOf = (pr: MergedPR, outcome: string, running?: string[]): Claim =>
  ({ outcome, ts: new Date().toISOString(), branch: pr.headRefName, url: pr.url, mergedAt: pr.mergedAt, running });

/** Write `c` to a temp file next to `path`, then link it in (exclusive) or rename it over (replace). */
async function writeClaim(path: string, c: Claim, mode: "exclusive" | "replace"): Promise<boolean> {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(c) + "\n");
  if (mode === "replace") {
    await rename(tmp, path);
    return true;
  }
  try {
    linkSync(tmp, path);
    return true;
  } catch {
    return false;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** The claim on PR #n: null when there is none; an unreadable one counts as handled. */
async function readClaim(project: string, n: number): Promise<Claim | null> {
  const f = Bun.file(claimPath(project, n));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as Claim;
  } catch {
    return { outcome: "unreadable", ts: "", branch: "", url: "", mergedAt: "" };
  }
}

const stale = (c: Claim) => c.outcome === "started" && Date.now() - Date.parse(c.ts) > STALE_CLAIM_MS;

/** Take over a stale "started" claim; one taker per stale claim. Returns its running list, or null if someone else has it. */
async function takeOver(project: string, pr: MergedPR, old: Claim): Promise<string[] | null> {
  const mark = `${claimPath(project, pr.number)}.retry-${old.ts.replace(/[^0-9A-Za-z]/g, "")}`;
  if (!(await writeClaim(mark, old, "exclusive"))) return null;
  const running = old.running ?? [];
  await writeClaim(claimPath(project, pr.number), claimOf(pr, "started", running), "replace");
  return running;
}

// --- which PRs ---------------------------------------------------------------

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

/** main, master, HEAD, the checked-out branch and origin's default branch (cached once known). */
async function protectedBranches(project: string, w: Watcher): Promise<Set<string>> {
  const repo = paths.repo(project);
  const out = new Set(PROTECTED);
  const head = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (ok(head)) out.add(head!.out.trim());
  if (!w.defaults.has(project)) {
    const def = await git(repo, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
    if (ok(def)) w.defaults.set(project, def!.out.trim().replace(/^origin\//, ""));
  }
  const def = w.defaults.get(project);
  if (def) out.add(def);
  return out;
}

/** Merged PRs that may need handling: ours (not a fork), not protected, not claimed (or a stale claim). */
async function candidates(project: string, prs: MergedPR[], w: Watcher): Promise<{ pr: MergedPR; claim: Claim | null }[]> {
  const ours = prs.filter((pr) => !pr.isCrossRepository);
  if (!ours.length) return [];
  const prot = await protectedBranches(project, w);
  const out: { pr: MergedPR; claim: Claim | null }[] = [];
  for (const pr of ours) {
    if (prot.has(pr.headRefName)) continue;
    const c = await readClaim(project, pr.number);
    if (!c || stale(c)) out.push({ pr, claim: c });
  }
  return out;
}

/** The branch a worktree is on: its name, "a detached HEAD" or "an unknown branch". */
async function worktreeOn(wt: string): Promise<string> {
  const head = await git(wt, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (ok(head)) return head!.out.trim();
  return head?.code === 1 ? "a detached HEAD" : "an unknown branch";
}

/** Whether the local branch has nothing the PR lacks: its tip is the PR's head or an ancestor (the head is fetched if unknown here). Null when unreadable. */
async function tipInPR(repo: string, pr: MergedPR): Promise<boolean | null> {
  const tip = await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${pr.headRefName}^{commit}`]);
  if (tip?.code === 1) return true; // no local branch: nothing of ours to lose
  if (!ok(tip)) return null;
  const t = tip!.out.trim();
  if (t === pr.headRefOid) return true;
  if (!ok(await git(repo, ["cat-file", "-e", `${pr.headRefOid}^{commit}`]))) await git(repo, ["fetch", "-q", "origin", pr.headRefOid], GIT_NET_TIMEOUT_MS);
  return ok(await git(repo, ["merge-base", "--is-ancestor", t, pr.headRefOid]));
}

/**
 * Why the branch here is not the PR's, or null when it is: the worktree must
 * be on the PR's branch by name (two names can share a slug), and the local
 * tip must be the PR's head or an ancestor of it (no commits the PR lacks).
 */
async function notThePR(project: string, pr: MergedPR, s: string): Promise<string | null> {
  const wt = paths.worktree(project, s);
  if (existsSync(wt)) {
    const on = await worktreeOn(wt);
    if (on !== pr.headRefName) return `worktree is on ${on}`;
  }
  const inPR = await tipInPR(paths.repo(project), pr);
  if (inPR === null) return "could not read the branch";
  return inPR ? null : "branch has commits not in the pr";
}

// --- stop and clean up ---------------------------------------------------------

/** Close the agents' current runs, kill their windows, wait for their processes. Returns the runs closed and whether all are gone. */
async function stopAgents(project: string, s: string, live: string[], d: Deps): Promise<{ runs: (string | null)[]; gone: boolean }> {
  const agents = ids(s);
  const states = await Promise.all(agents.map((id) => readRun(project, id)));
  // Deliberate: claim first, so the agents' own exit paths and the watchdog send nothing.
  for (const [i, id] of agents.entries()) if (states[i]) await claim(project, id, states[i]!.run);
  for (const id of agents) if (live.includes(id)) await d.kill(project, id);
  const pids = states.flatMap((r) => (r ? [r.pid] : []));
  const deadline = Date.now() + d.waitMs;
  while (pids.some((p) => d.alive(p)) && Date.now() < deadline) await Bun.sleep(50);
  return { runs: states.map((r) => r?.run ?? null), gone: !pids.some((p) => d.alive(p)) };
}

/** Why to keep everything after the stop: a window or run that appeared meanwhile, or tmux not answering. */
async function newAgent(project: string, s: string, runs: (string | null)[], d: Deps): Promise<string | null> {
  const agents = ids(s);
  const live = await d.live(project).catch(() => null);
  if (live === null) return "could not check for new agents";
  const now = await Promise.all(agents.map((id) => readRun(project, id)));
  const fresh = agents.some((id, i) => live.includes(id) || (now[i]?.run ?? null) !== runs[i]);
  return fresh ? "a new agent started on the branch" : null;
}

/** Remove the worktree (--force: ignored files such as .env go too), the local and the remote branch. Returns what went wrong. */
async function removeBranches(project: string, branch: string): Promise<string[]> {
  const repo = paths.repo(project);
  const problems: string[] = [];
  try {
    await removeWorktree(project, branch);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    return problems; // An unverified or unremovable worktree must keep its branches too.
  }
  const local = await git(repo, ["branch", "-D", "--", branch]);
  if (local && local.code !== 0 && !/not found/i.test(local.err)) problems.push(`git branch -D: ${local.err.trim()}`);
  const remote = await git(repo, ["push", "origin", "--delete", branch], GIT_NET_TIMEOUT_MS);
  if (!remote) problems.push("git push --delete timed out");
  else if (remote.code !== 0 && !/remote ref does not exist|not found/i.test(remote.err)) problems.push(`git push --delete: ${remote.err.trim()}`);
  return problems.map((p) => p.replace(/\s+/g, " ").slice(0, 200));
}

/**
 * Delete the agents' transcripts, inboxes and runs/ files. The close claims
 * of their current runs stay (pruned after a day like any claim), so a late
 * follow-up still finds its run closed.
 */
async function removeAgentFiles(project: string, s: string): Promise<void> {
  const agents = ids(s);
  for (const id of agents) {
    await rm(paths.transcript(project, id), { force: true }).catch(() => {});
    await rm(join(paths.inbox(project), id), { recursive: true, force: true }).catch(() => {});
  }
  const runs = await Promise.all(agents.map((id) => readRun(project, id)));
  const keep = new Set(runs.flatMap((r, i) => (r ? [`${agents[i]}.${r.run}.exit`] : [])));
  for (const n of await runFiles(project, agents)) if (!keep.has(n)) await unlink(join(paths.runs(project), n)).catch(() => {});
}

/** Stop the agents, clean up what is safe to, pull main. Returns the notice's tail. */
async function stopAndClean(project: string, pr: MergedPR, s: string, live: string[], d: Deps): Promise<string> {
  const { runs, gone } = await stopAgents(project, s, live, d);
  const tail = await cleanTail(project, pr, s, gone, runs, d);
  const repo = paths.repo(project);
  // Background cleanup must not modify the user's original checkout.
  if (!repositoryBinding(project)) await git(repo, ["pull", "--ff-only", "--quiet"], GIT_NET_TIMEOUT_MS);
  return tail;
}

async function cleanTail(project: string, pr: MergedPR, s: string, gone: boolean, runs: (string | null)[], d: Deps): Promise<string> {
  if (!gone) return "kept everything: an agent process is still running";
  const fresh = await newAgent(project, s, runs, d);
  if (fresh) return `kept everything: ${fresh}`;
  const wt = paths.worktree(project, s);
  const dirty = existsSync(wt) ? await d.dirty(wt) : 0;
  if (dirty !== 0) return `kept worktree: ${dirty ?? "unknown"} uncommitted changes`;
  const problems = await removeBranches(project, pr.headRefName);
  await removeAgentFiles(project, s);
  return problems.length ? `cleaned up, except: ${problems.join("; ")}` : "cleaned up";
}

/** The notice for one merged branch; `conflicts` is the other open PRs' state after the merge (see `conflictsAfterMerge`), "" when there are none. */
export function mergeNotice(pr: MergedPR, running: string[], stopped: boolean, tail: string, conflicts = ""): string {
  const who = running.length ? `${running.join(", ")} ${stopped ? "stopped" : "left running"}` : "no agents running";
  return `[agent-exit] ${who}: pr #${pr.number} (${pr.headRefName}) merged (${pr.url}); ${tail}${conflicts ? `; ${conflicts}` : ""}`;
}

// --- the other open PRs after a merge ------------------------------------------

/**
 * Main moved: observe every other active task's PR (one `gh pr view` each,
 * tasks sharing a PR share the lookup). A PR GitHub now reports as conflicting
 * blocks its tasks (readiness invalidated) and is listed; one it has not
 * judged yet (mergeable UNKNOWN, or the lookup failed) is listed as unknown,
 * never as a conflict. Returns the notice's line, "" when no other task has a PR.
 */
async function conflictsAfterMerge(project: string, repository: string, merged: MergedPR, d: Deps): Promise<string> {
  const byPR = new Map<number, Task[]>();
  for (const t of await allTasks(project)) {
    if (t.archive || !t.pr || t.pr.repository !== repository.toLowerCase() || t.pr.number === merged.number) continue;
    byPR.set(t.pr.number, [...(byPR.get(t.pr.number) ?? []), t]);
  }
  if (!byPR.size) return "";
  const reason = `conflicts with main after PR #${merged.number} merged; rebase needed`;
  const conflicting: string[] = [], unknown: string[] = [];
  for (const [n, tasks] of byPR) {
    const o = await d.pr(project, tasks[0]!.pr!).catch(() => null);
    const label = `#${n} (${o?.branch ?? tasks[0]!.branch})`;
    if (o && o.state !== "OPEN") continue;
    if (!o || o.mergeable === "unknown" || o.mergeable === undefined) { unknown.push(label); continue; }
    if (o.mergeable !== "conflicting") continue;
    conflicting.push(label);
    for (const t of tasks) {
      // Block first: the observation alone would drop readiness without saying why.
      await blockConflictingTask(project, t.id, reason).catch(() => {});
      await observeTaskPR(project, t.id, o).catch(() => {});
    }
  }
  const parts: string[] = [];
  if (conflicting.length) parts.push(`conflicts with main now: ${conflicting.join(", ")}`);
  if (unknown.length) parts.push(`conflict state unknown (github has not computed it yet): ${unknown.join(", ")}`);
  return parts.length ? parts.join("; ") : "no open PRs conflict";
}

// --- one PR, one project ------------------------------------------------------

/** Claim the PR, or take over a stale claim. Returns the agents to name as running, or null when there is nothing to do. */
async function claimPR(project: string, pr: MergedPR, prev: Claim | null, live: string[]): Promise<string[] | null> {
  const s = slug(pr.headRefName);
  const path = claimPath(project, pr.number);
  if (prev) return takeOver(project, pr, prev);
  if (!(await hasState(project, s, live))) {
    // Nothing of it here: mark it seen, so a later branch of the same name is never taken for it.
    await writeClaim(path, claimOf(pr, "nothing to do"), "exclusive");
    return null;
  }
  if (reused(project, s, pr)) {
    await writeClaim(path, claimOf(pr, "branch reused after the merge"), "exclusive");
    return null;
  }
  const running = ids(s).filter((id) => live.includes(id));
  return (await writeClaim(path, claimOf(pr, "started", running), "exclusive")) ? running : null;
}

/** Handle one merged PR: check, stop, clean up, notify. False when there was nothing to do or another watcher has it. */
async function handleMerge(project: string, repo: string, pr: MergedPR, prev: Claim | null, live: string[], d: Deps): Promise<boolean> {
  const running = await claimPR(project, pr, prev, live);
  if (!running) return false;
  const s = slug(pr.headRefName);
  let stopping = false;
  try {
    const why = await notThePR(project, pr, s);
    stopping = !why;
    const tail = why ? `kept: ${why}` : await stopAndClean(project, pr, s, live, d);
    const conflicts = await conflictsAfterMerge(project, repo, pr, d).catch(() => "");
    await put(project, "orchestrator", { from: running[0] ?? `worker-${s}`, text: mergeNotice(pr, running, !why, tail, conflicts) });
    await writeClaim(claimPath(project, pr.number), claimOf(pr, why ? `kept: ${why}` : "handled", running), "replace");
    return true;
  } catch (err) {
    // Nothing stopped yet: let the next check start over. Once agents were
    // stopped the claim stays "started" and is taken over when stale.
    if (!stopping) await unlink(claimPath(project, pr.number)).catch(() => {});
    throw err;
  }
}

async function handleProject(project: string, w: Watcher): Promise<number[]> {
  const repo = await w.d.repo(project).catch(() => null);
  if (!repo) return [];
  const prs = await w.d.gh(paths.repo(project), repo).catch(() => null);
  if (!prs) { await refreshTaskPRs(project, repo, w); return []; }
  // Archive before cleanup claims, tmux checks or worktree deletion. Invalid/foreign
  // observations never remove a row; repeats are idempotent, including after restart.
  for (const pr of prs) {
    if (pr.isCrossRepository) continue;
    try { await archiveMergedTasks(project, taskPR({ repository: repo, number: pr.number, url: pr.url, head: pr.headRefOid }), pr.mergedAt); }
    catch { /* unknown/malformed merge or failed persistence: retain and retry */ }
  }
  await refreshTaskPRs(project, repo, w);
  const todo = await candidates(project, prs, w);
  if (!todo.length) return [];
  const live = await w.d.live(project).catch(() => null);
  if (live === null) return [];
  const done: number[] = [];
  for (const { pr, claim: c } of todo) if (await handleMerge(project, repo, pr, c, live, w.d).catch(() => false)) done.push(pr.number);
  return done;
}

/** One project's check: at most every `every` ms, never two at once. */
async function checkProject(project: string, w: Watcher): Promise<number[]> {
  if (w.busy.has(project)) return [];
  const t = w.now();
  if (t - (w.last.get(project) ?? -Infinity) < w.every) return [];
  w.busy.add(project);
  w.last.set(project, t);
  try {
    return await handleProject(project, w);
  } finally {
    w.busy.delete(project);
  }
}

/**
 * The daemon's merge watcher: `check(project)` lists merged PRs at most every
 * `everyMs` per project, one check per project at a time, and handles each
 * merged branch that still has a worktree, agent windows, transcripts or runs.
 * A non-GitHub origin, or gh or tmux failing, skips the check quietly; it is
 * retried later. Returns the PR numbers notified.
 */
export function mergeWatcher(opts: MergeWatchOptions) {
  const w: Watcher = {
    d: {
      pr: opts.pr ?? ghTaskPR,
      gh: opts.gh ?? ((cwd, repo) => ghMerged(cwd, repo)),
      repo: opts.repo ?? originRepo,
      live: opts.live,
      kill: opts.kill ?? ((project, window) => tmux.killWindow(sessionName(project), window)),
      alive: opts.alive ?? pidAlive,
      dirty: opts.dirty ?? ((cwd) => dirtyCount(cwd)),
      waitMs: opts.waitMs ?? STOP_WAIT_MS,
    },
    now: opts.now ?? Date.now,
    every: opts.everyMs ?? MERGE_POLL_MS,
    last: new Map(),
    busy: new Set(),
    defaults: new Map(),
  };
  return (project: string) => checkProject(project, w);
}

async function refreshTaskPRs(project: string, repository: string, w: Watcher): Promise<void> {
  const tasks = (await allTasks(project)).filter(t => !t.archive && t.pr?.repository === repository.toLowerCase());
  const observations = new Map<string, PRObservation | null>();
  for (const t of tasks) {
    const key = `${t.pr!.repository}#${t.pr!.number}`;
    if (!observations.has(key)) observations.set(key, await w.d.pr(project, t.pr!).catch(() => null));
    const observation = observations.get(key);
    if (!observation && t.readiness) await setTaskAttention(project, t.id, { kind: "unknown", reason: "pr lookup unavailable; revalidate readiness when github is observable" }, t.revision).catch(() => {});
    if (observation) await observeTaskPR(project, t.id, observation, t.revision).catch(() => {});
  }
}
