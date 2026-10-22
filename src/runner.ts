import { publishLaunch } from "./cancellation";
import { command, run } from "./proc";
// Starts agents. v1 has one backend: a git worktree plus a tmux window on this
// machine. A docker/container backend comes later with the same interface, so
// agents never learn anything about the host beyond their cwd.
//
// Everything is keyed by branch: one worktree, one window per role, and one
// transcript per role on that branch. There is no task list on disk.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { paths } from "./config";
import type { Role } from "./transcript";

export interface StartOptions {
  /** Exact launch, published before this session becomes selectable. */
  run?: string;
  signal?: AbortSignal;
  project: string;
  role: Role;
  /** Branch to work on. Omitted for the orchestrator, which runs in repo/. */
  branch?: string;
}

export interface Runner {
  /** Create the worktree if needed and start `parallels agent` in a tmux window. */
  start(opts: StartOptions): Promise<void>;
  /** Close the branch's windows and remove its worktree. */
  stop(project: string, branch: string): Promise<void>;
  /** Which of these agent ids have a live window, or null when that could not be asked. */
  running(project: string, ids: string[], signal?: AbortSignal): Promise<string[] | null>;
}

const CLI = resolve(import.meta.dir, "cli.ts");

function need(bin: string): string {
  const found = Bun.which(bin);
  if (!found) throw new Error(`runner: ${bin} not found on PATH`);
  return found;
}

/** A branch name as a safe directory / window / transcript name. */
export const slug = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, "-");
export const sessionName = (project: string) => `parallels-${project}`;
export const windowName = (role: Role, branch?: string) =>
  role === "orchestrator" || !branch ? role : `${role}-${slug(branch)}`;
/** Transcript id for a role on a branch; the orchestrator has one transcript. */
export const sessionId = (role: Role, branch?: string) => windowName(role, branch);

// --- git ---------------------------------------------------------------------

/**
 * Ensure a worktree for `branch` exists, creating the branch from the repo's
 * HEAD if needed. Reusing an existing worktree is how a reviewer shares the
 * worker's checkout.
 */
export async function ensureWorktree(project: string, branch: string, signal?: AbortSignal): Promise<string> {
  need("git");
  const repo = paths.repo(project);
  const dir = paths.worktree(project, slug(branch));
  if (existsSync(dir)) return dir;
  if (!existsSync(repo)) throw new Error(`runner: repo not found at ${repo}`);

  const exists = (await command(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo, signal)).code === 0;
  const res = await command(["git", "worktree", "add", ...(exists ? [dir, branch] : ["-b", branch, dir, "HEAD"])], repo, signal);
  if (res.code !== 0) throw new Error(`runner: git worktree add failed: ${res.err.trim()}`);
  return dir;
}

export async function removeWorktree(project: string, branch: string): Promise<void> {
  need("git");
  const repo = paths.repo(project);
  const dir = paths.worktree(project, slug(branch));
  if (existsSync(dir)) {
    const res = await $`git -C ${repo} worktree remove --force ${dir}`.quiet().nothrow();
    if (res.exitCode !== 0) throw new Error(`runner: git worktree remove failed: ${res.stderr.toString().trim()}`);
  }
  await $`git -C ${repo} worktree prune`.quiet().nothrow();
}

// --- tmux --------------------------------------------------------------------

export const tmux = {
  async hasSession(session: string, signal?: AbortSignal): Promise<boolean> {
    need("tmux");
    return (await command(["tmux", "has-session", "-t", "=" + session], process.cwd(), signal)).code === 0;
  },

  /** Create the session detached if missing. Its first window is an idle shell so the session outlives agent windows. */
  async ensureSession(session: string, cwd: string, signal?: AbortSignal): Promise<void> {
    if (await tmux.hasSession(session, signal)) return;
    const res = await command(["tmux", "new-session", "-d", "-s", session, "-n", "shell", "-c", cwd], cwd, signal);
    if (res.code !== 0) throw new Error(`runner: tmux new-session failed: ${res.err.trim()}`);
  },

  /** Open a named window in `session` in `cwd`, running `command`: a shell string (run by tmux's default shell) or an argv (exec'd directly). */
  async openWindow(session: string, name: string, cwd: string, commandLine: string | string[], signal?: AbortSignal): Promise<void> {
    need("tmux");
    const argv = typeof commandLine === "string" ? [commandLine] : ["--", ...commandLine];
    const res = await command(["tmux", "new-window", "-d", "-t", "=" + session, "-n", name, "-c", cwd, ...argv], cwd, signal);
    if (res.code !== 0) throw new Error(`runner: tmux new-window failed: ${res.err.trim()}`);
  },

  async listWindows(session: string): Promise<string[]> {
    return (await tmux.windows(session)) ?? [];
  },

  /**
   * A session's window names: [] when the session or the tmux server is gone,
   * null when tmux could not be asked (not installed, or any other error), so
   * callers can tell "no windows" from "don't know".
   */
  async windows(session: string, signal?: AbortSignal): Promise<string[] | null> {
    if (!Bun.which("tmux")) return null;
    const out = await run(["tmux", "list-windows", "-t", "=" + session, "-F", "#{window_name}"], { cwd: process.cwd(), timeoutMs: 60_000, signal });
    if (!out) return null;
    if (out.code === 0) return out.out.split("\n").filter(Boolean);
    const err = out.err;
    return /can't find session|no server running|error connecting to .*\((No such file or directory|Connection refused)\)/i.test(err) ? [] : null;
  },

  async killWindow(session: string, name: string): Promise<void> {
    await $`tmux kill-window -t ${`=${session}:=${name}`}`.quiet().nothrow();
  },

  async killSession(session: string): Promise<void> {
    await $`tmux kill-session -t ${"=" + session}`.quiet().nothrow();
  },

  /** Hand the terminal to a window until the user detaches (prefix-d). Inside tmux, switch instead. */
  attach(session: string, name: string): number {
    need("tmux");
    const target = `=${session}:=${name}`;
    const args = process.env.TMUX ? ["switch-client", "-t", target] : ["attach", "-t", target];
    return Bun.spawnSync(["tmux", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode;
  },
};

// --- runner ------------------------------------------------------------------

/** Exit code of an agent whose run is already closed (its crash notice went out, or it ended on a report); the follow-up skips it. */
export const SETTLED_EXIT = 70;

/**
 * The follow-up script run by `sh -c` around a worker or reviewer. Values
 * arrive as positional parameters ($1 PARALLELS_HOME, $2 cli.ts, $3 project,
 * $4 role, $5 branch, $6 run id), never spliced into the script, so nothing
 * is quoted at all.
 */
const WRAPPER = [
  `PARALLELS_HOME="$1" bun "$2" agent --project "$3" --role "$4" --branch "$5" --run "$6"`,
  `code=$?`,
  `case "$code" in 0|${SETTLED_EXIT}) ;; *) PARALLELS_HOME="$1" bun "$2" agent-exit --project "$3" --role "$4" --branch "$5" --run "$6" --code "$code" ;; esac`,
  `exit "$code"`,
].join("\n");

/**
 * The tmux window's command as an argv, which tmux execs directly without the
 * user's default shell (fish, zsh, ...). Workers and reviewers run under a
 * fixed `sh -c` script: if the agent exits non-zero and not SETTLED_EXIT (a
 * signal, OOM, an uncaught error), `parallels agent-exit` sends the
 * orchestrator an `[agent-exit]` notice unless the run is already closed
 * (src/exits.ts). Both share one run id.
 */
export function agentCommand(opts: StartOptions, run: string = crypto.randomUUID().slice(0, 8)): string[] {
  if (opts.role === "orchestrator" || !opts.branch) {
    return ["env", `PARALLELS_HOME=${paths.root}`, "bun", CLI, "agent", "--project", opts.project, "--role", opts.role];
  }
  return ["sh", "-c", WRAPPER, "sh", paths.root, CLI, opts.project, opts.role, opts.branch, run];
}

export const local: Runner = {
  async start(opts) {
    need("git");
    need("tmux");
    let cwd: string;
    if (opts.branch) {
      cwd = await ensureWorktree(opts.project, opts.branch, opts.signal);
    } else {
      cwd = paths.repo(opts.project);
      if (!existsSync(cwd)) throw new Error(`runner: repo not found at ${cwd}`);
    }
    const session = sessionName(opts.project);
    await tmux.ensureSession(session, paths.repo(opts.project), opts.signal);
    const run = opts.run ?? crypto.randomUUID();
    if (!opts.run) publishLaunch(opts.project, sessionId(opts.role, opts.branch), run);
    await tmux.openWindow(session, windowName(opts.role, opts.branch), cwd, agentCommand(opts, run), opts.signal);
  },

  async stop(project, branch) {
    const session = sessionName(project);
    for (const name of await tmux.listWindows(session)) {
      if (name.endsWith(`-${slug(branch)}`)) await tmux.killWindow(session, name);
    }
    await removeWorktree(project, branch);
  },

  async running(project, ids, signal) {
    const w = await tmux.windows(sessionName(project), signal);
    return w && ids.filter((id) => w.includes(id));
  },
};
