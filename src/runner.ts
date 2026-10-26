import { delay, publishLaunch } from "./cancellation";
import { claim, readRun } from "./exits";
import { command, run } from "./proc";
// Starts agents. v1 has one backend: a git worktree plus a tmux window on this
// machine. A docker/container backend comes later with the same interface, so
// agents never learn anything about the host beyond their cwd.
//
// Everything is keyed by branch: one worktree, one window per role, and one
// transcript per role on that branch. tasks.ts separately binds immutable tasks to exact runs.

import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { $ } from "bun";
import { paths, repositoryBinding } from "./config";
import { assertMainCheckout, assertWorktree } from "./workspace";
import { launchEnvironment } from "./launch-environment";
import type { Role } from "./transcript";

export interface StartOptions {
  /** Exact launch, published before this session becomes selectable. */
  run?: string;
  signal?: AbortSignal;
  project: string;
  role: Role;
  /** Branch to work on. Omitted for the orchestrator in the original checkout. */
  branch?: string;
}

export interface Runner {
  /** Create the worktree if needed and start `orca agent` in a tmux window. */
  start(opts: StartOptions): Promise<void>;
  /** Close the branch's windows and remove its worktree. */
  stop(project: string, branch: string): Promise<void>;
  /** Which of these agent ids have a live window, or null when that could not be asked. */
  running(project: string, ids: string[], signal?: AbortSignal): Promise<string[] | null>;
}

/** Re-enter this exact executable, not a build-machine path or a Bun found on PATH.
 * Development still runs cli.ts using the current (absolute) Bun executable.
 */
export function cliCommand(): string[] {
  return Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "cli.ts")];
}

function need(bin: string): string {
  const found = Bun.which(bin);
  if (!found) throw new Error(`runner: ${bin} not found on PATH`);
  return found;
}

/** A branch name as a safe directory / window / transcript name. */
export const slug = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, "-");
export const sessionName = (project: string) => `orca-${project}`;
export const windowName = (role: Role, branch?: string) =>
  role === "orchestrator" || !branch ? role : `${role}-${slug(branch)}`;
/** Transcript id for a role on a branch; the orchestrator has one transcript. */
export const sessionId = (role: Role, branch?: string) => windowName(role, branch);

// --- git ---------------------------------------------------------------------

/**
 * Ensure a worktree for `branch` exists, creating the branch from the repo's
 * default branch if needed (HEAD for legacy projects). Reusing a worktree lets a reviewer share the
 * worker's checkout.
 */
export async function ensureWorktree(project: string, branch: string, signal?: AbortSignal): Promise<string> {
  need("git");
  const repo = paths.repo(project);
  const dir = paths.worktree(project, slug(branch));
  if (!branch || slug(branch) === "." || slug(branch) === "..") throw new Error("invalid worker branch");
  const base = repositoryBinding(project)?.branch;
  if (branch === base) throw new Error("workers must use a task branch, not the default branch");
  if (existsSync(dir)) { await assertWorktree(project, dir, branch); return dir; }
  if (!existsSync(repo)) throw new Error(`runner: repo not found at ${repo}`);

  const exists = (await command(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo, signal)).code === 0;
  const res = await command(["git", "worktree", "add", ...(exists ? [dir, branch] : ["-b", branch, dir, base ? `refs/heads/${base}` : "HEAD"])], repo, signal);
  if (res.code !== 0) throw new Error(`runner: git worktree add failed: ${res.err.trim()}`);
  return dir;
}

export async function removeWorktree(project: string, branch: string): Promise<void> {
  need("git");
  const repo = paths.repo(project);
  const dir = paths.worktree(project, slug(branch));
  if (existsSync(dir)) {
    await assertWorktree(project, dir, branch);
    const res = await $`git -C ${repo} worktree remove --force ${dir}`.quiet().nothrow();
    if (res.exitCode !== 0) throw new Error(`runner: git worktree remove failed: ${res.stderr.toString().trim()}`);
  }
  await $`git -C ${repo} worktree prune`.quiet().nothrow();
}

// --- tmux --------------------------------------------------------------------

/** Longest socket path a unix socket accepts everywhere (sun_path is 104 bytes on macOS). */
const SOCKET_PATH_MAX = 100;

/**
 * Where orca's tmux server listens: `-S $ORCA_HOME/tmux.sock`, or `-L orca`
 * when that path is too long for a socket. Never the user's default server:
 * a stale one (started days ago from a directory since moved or deleted, e.g.
 * into ~/.Trash) opens every window with a broken cwd, and every agent dies
 * at startup.
 */
export function tmuxSocket(): string[] {
  const path = paths.tmuxSocket;
  return Buffer.byteLength(path) > SOCKET_PATH_MAX ? ["-L", "orca"] : ["-S", path];
}

/** The shell command that stops orca's tmux server, for error messages. */
export const killServerCommand = () => `tmux ${tmuxSocket().join(" ")} kill-server`;

/** A pane's state: dead (its command exited, with its status) or running; null when the pane is gone. */
export interface PaneState { dead: boolean; status: number | null; signal: string }

/** The last non-blank lines of a dead pane's screen, without tmux's own "Pane is dead" footer. */
function tail(screen: string, lines = 20, max = 2000): string {
  const kept = screen.split("\n").map((l) => l.trimEnd()).filter((l) => l && !/^Pane is dead\b/.test(l));
  const text = kept.slice(-lines).join("\n");
  return text.length > max ? `…${text.slice(-max)}` : text;
}

export const tmux = {
  /** `tmux` argv on orca's own server. */
  argv(...args: string[]): string[] {
    return ["tmux", ...tmuxSocket(), ...args];
  },

  async hasSession(session: string, signal?: AbortSignal): Promise<boolean> {
    need("tmux");
    return (await command(tmux.argv("has-session", "-t", "=" + session), process.cwd(), signal)).code === 0;
  },

  /**
   * Create the session detached if missing. Its first window is an idle shell so the session outlives agent windows.
   * The client that creates the session also starts orca's server, and a tmux server keeps that client's cwd for
   * life: a checkout that is later moved or deleted would break every new pane (tmux/tmux#5473, the original
   * incident), so the server starts in `paths.root`, which outlives any project; the window itself still opens in `cwd`.
   * On the same (first) call, `remain-on-exit on` becomes a global window option of orca's server, so a window whose
   * command dies at once keeps its screen for the launch check (confirmLaunch turns it off per window once confirmed).
   */
  async ensureSession(session: string, cwd: string, signal?: AbortSignal): Promise<void> {
    if (await tmux.hasSession(session, signal)) return;
    mkdirSync(paths.root, { recursive: true }); // the socket's directory and the server's cwd
    const res = await command(tmux.argv("new-session", "-d", "-s", session, "-n", "shell", "-c", cwd, ";", "set-option", "-g", "remain-on-exit", "on"), paths.root, signal);
    if (res.code !== 0) throw new Error(`runner: tmux new-session failed: ${res.err.trim()}`);
  },

  /**
   * The server must be able to run commands: `run-shell pwd` is expected to
   * fail when its working directory is gone or forbidden (macOS denies
   * ~/.Trash), as every window it opens then does. A best-effort early hint
   * (not reproduced against the original stale server; confirmLaunch is the
   * authoritative catch for a window that dies). Points at kill-server, which
   * also stops every agent on it.
   */
  async checkServer(signal?: AbortSignal): Promise<void> {
    const res = await command(tmux.argv("run-shell", "pwd"), process.cwd(), signal);
    if (res.code === 0) return;
    const detail = (res.err || res.out).trim();
    throw new Error(`runner: the orca tmux server cannot run commands (${detail || `exit ${res.code}`}); its working directory is probably gone or not permitted. Stop it with \`${killServerCommand()}\` (this also stops every agent on it) and spawn again`);
  },

  /**
   * Open a named window in `session` in `cwd`, running `command`: a shell string (run by tmux's default shell) or an argv (exec'd directly).
   * Returns its pane id. The pane keeps its screen when its command exits (the server's global remain-on-exit, see ensureSession);
   * the caller turns that off once the launch is confirmed, or captures and kills the dead pane.
   */
  async openWindow(session: string, name: string, cwd: string, commandLine: string | string[], signal?: AbortSignal): Promise<string> {
    need("tmux");
    const argv = typeof commandLine === "string" ? [commandLine] : ["--", ...commandLine];
    const res = await command(tmux.argv("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=" + session, "-n", name, "-c", cwd, ...argv), cwd, signal);
    if (res.code !== 0) throw new Error(`runner: tmux new-window failed: ${res.err.trim()}`);
    const pane = res.out.trim().split("\n")[0] ?? "";
    if (!/^%\d+$/.test(pane)) throw new Error(`runner: tmux new-window did not report a pane id (${res.out.trim() || "no output"})`);
    return pane;
  },

  /** Whether `pane` has exited, and how; null when it no longer exists (display-message answers for another pane, or none, then). */
  async pane(pane: string, signal?: AbortSignal): Promise<PaneState | null> {
    const res = await command(tmux.argv("display-message", "-p", "-t", pane, "#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}"), process.cwd(), signal);
    if (res.code !== 0) return null;
    const [id = "", dead = "", status = "", sig = ""] = res.out.trim().split("\t");
    if (id !== pane) return null;
    return { dead: dead === "1", status: /^\d+$/.test(status) ? Number(status) : null, signal: sig };
  },

  /** Keep or drop `pane` when its command exits: set on its window (one pane per agent window), which overrides the server's global. */
  async keepOnExit(pane: string, on: boolean, signal?: AbortSignal): Promise<void> {
    await command(tmux.argv("set-option", "-w", "-t", pane, "remain-on-exit", on ? "on" : "off"), process.cwd(), signal);
  },

  /** The last lines on `pane`'s screen, history included (a window's first line can scroll off during layout); "" when it cannot be read. */
  async capturePane(pane: string, signal?: AbortSignal): Promise<string> {
    const res = await command(tmux.argv("capture-pane", "-p", "-J", "-S", "-", "-t", pane), process.cwd(), signal).catch(() => null);
    return res?.code === 0 ? tail(res.out) : "";
  },

  async killPane(pane: string): Promise<void> {
    await run(tmux.argv("kill-pane", "-t", pane), { cwd: process.cwd(), timeoutMs: 60_000 });
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
    const out = await run(tmux.argv("list-windows", "-t", "=" + session, "-F", "#{window_name}"), { cwd: process.cwd(), timeoutMs: 60_000, signal });
    if (!out) return null;
    if (out.code === 0) return out.out.split("\n").filter(Boolean);
    const err = out.err;
    return /can't find session|no server running|error connecting to .*\((No such file or directory|Connection refused)\)/i.test(err) ? [] : null;
  },

  async killWindow(session: string, name: string): Promise<void> {
    await run(tmux.argv("kill-window", "-t", `=${session}:=${name}`), { cwd: process.cwd(), timeoutMs: 60_000 });
  },

  async killSession(session: string): Promise<void> {
    await run(tmux.argv("kill-session", "-t", "=" + session), { cwd: process.cwd(), timeoutMs: 60_000 });
  },

  /**
   * Hand the terminal to a window until the user detaches (prefix-d). Inside
   * a client of orca's own server, switch instead; inside another tmux
   * server the client is not ours, so attach nested (TMUX unset for the
   * attach alone; the outer prefix must be doubled to reach the inner).
   */
  attach(session: string, name: string): number {
    need("tmux");
    const target = `=${session}:=${name}`;
    const inside = process.env.TMUX?.split(",")[0];
    const [flag, socket] = tmuxSocket();
    const ours = !!inside && (flag === "-S" ? inside === socket : basename(inside) === socket);
    const env = { ...process.env };
    if (!ours) delete env.TMUX;
    const args = ours ? ["switch-client", "-t", target] : ["attach", "-t", target];
    return Bun.spawnSync(tmux.argv(...args), { stdin: "inherit", stdout: "inherit", stderr: "inherit", env }).exitCode;
  },
};

// --- runner ------------------------------------------------------------------

/** Exit code of an agent whose run is already closed (its crash notice went out, or it ended on a report); the follow-up skips it. */
export const SETTLED_EXIT = 70;

/**
 * The follow-up script run by `sh -c` around a worker or reviewer. Values
 * arrive as positional parameters (home, project, role, branch, run, then
 * the CLI argv). After shifting the metadata, "$@" preserves either a single
 * compiled executable or Bun + source, including spaces/quotes in every path.
 */
const WRAPPER = [
  `export ORCA_HOME="$1"`,
  `project="$2" role="$3" branch="$4" run="$5"`,
  `shift 5`,
  `"$@" agent --project "$project" --role "$role" --branch "$branch" --run "$run"`,
  `code=$?`,
  `case "$code" in 0|${SETTLED_EXIT}) ;; *) "$@" agent-exit --project "$project" --role "$role" --branch "$branch" --run "$run" --code "$code" ;; esac`,
  `exit "$code"`,
].join("\n");

/**
 * The tmux window's command as an argv, which tmux execs directly without the
 * user's default shell (fish, zsh, ...). Workers and reviewers run under a
 * fixed `sh -c` script: if the agent exits non-zero and not SETTLED_EXIT (a
 * signal, OOM, an uncaught error), `orca agent-exit` sends the
 * orchestrator an `[agent-exit]` notice unless the run is already closed
 * (src/exits.ts). Both share one run id.
 */
export function agentCommand(opts: StartOptions, run: string = crypto.randomUUID().slice(0, 8), cli: string[] = cliCommand()): string[] {
  if (opts.role === "orchestrator" || !opts.branch) {
    return ["env", `ORCA_HOME=${paths.root}`, ...cli, "agent", "--project", opts.project, "--role", opts.role];
  }
  return ["sh", "-c", WRAPPER, "sh", paths.root, opts.project, opts.role, opts.branch, run, ...cli];
}

/** How long start waits for evidence that the agent process is up, and how often it looks. */
export const LAUNCH_WAIT_MS = 5000;
const LAUNCH_POLL_MS = 100;

/**
 * The error a launch fails with when its window dies first. `output` is the
 * pane's last lines, if any; `reported` tells whether this error is the run's
 * notice (the launch check closed the run) or someone else already sent one.
 */
export class LaunchFailed extends Error {
  constructor(id: string, readonly pane: PaneState | null, readonly output: string, readonly reported: boolean) {
    super(`${id} ${LaunchFailed.how(pane)} before the agent started${LaunchFailed.detail(pane, output, reported)}`);
    this.name = "LaunchFailed";
  }

  private static how(pane: PaneState | null): string {
    if (!pane) return "exited";
    if (pane.signal) return `exited (signal ${pane.signal})`;
    if (pane.status !== null && pane.status > 128) return `exited (code ${pane.status}, signal ${pane.status - 128})`;
    return `exited (code ${pane.status ?? "unknown"})`;
  }

  private static detail(pane: PaneState | null, output: string, reported: boolean): string {
    const notice = reported ? "" : "; its exit notice is already in your inbox";
    if (output) return `${notice}; last output:\n${output}`;
    return `${notice}${pane ? "; no output" : "; its window was already gone, so no output could be captured"}`;
  }
}

/** The pane is confirmed (or given up on): stop keeping it after exit; a pane that already died is removed. */
async function settlePane(pane: string, state: PaneState | null, signal?: AbortSignal): Promise<void> {
  if (state && !state.dead) await tmux.keepOnExit(pane, false, signal);
  else if (state) await tmux.killPane(pane);
}

/**
 * The window died before the agent started: close the run first (so the
 * shell follow-up and the watchdog send nothing more; if someone else got
 * there first, the error says so), then read and remove the dead pane.
 */
async function failLaunch(project: string, id: string, run: string, pane: string, state: PaneState | null, signal?: AbortSignal): Promise<never> {
  const reported = await claim(project, id, run).catch(() => false);
  const output = state ? await tmux.capturePane(pane, signal) : "";
  if (state) await tmux.killPane(pane);
  throw new LaunchFailed(id, state, output, reported);
}

/** One look at a launch: whether this run's record exists (supervised agents only) and how its pane is. */
async function observeLaunch(project: string, id: string, run: string, pane: string, supervised: boolean, signal?: AbortSignal): Promise<{ up: boolean; state: PaneState | null }> {
  const started = async () => supervised && (await readRun(project, id))?.run === run;
  let up = await started();
  const state = await tmux.pane(pane, signal);
  if (!up && (!state || state.dead)) up = await started(); // it may have begun and died between the two reads
  return { up, state };
}

/** Poll until the launch is confirmed (settle), the pane died first (fail) or the deadline passes with it still running (settle). */
async function awaitLaunch(project: string, id: string, run: string, pane: string, supervised: boolean, deadline: number, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const { up, state } = await observeLaunch(project, id, run, pane, supervised, signal);
    const confirmed = up || (!supervised && state?.dead && state.status === 0);
    if (!confirmed && (!state || state.dead)) await failLaunch(project, id, run, pane, state, signal);
    if (confirmed || Date.now() >= deadline) return settlePane(pane, state, signal);
    await delay(LAUNCH_POLL_MS, signal);
  }
}

/**
 * Wait up to LAUNCH_WAIT_MS for the agent behind `pane` to be up. Evidence:
 * runs/<id>.json carrying this run (beginRun writes it first thing in a
 * supervised agent), or, for the orchestrator (never supervised, so no run
 * record), the pane having exited 0 or still running at the deadline. A pane
 * that died without it fails the launch (failLaunch). A pane still running at
 * the deadline passes: a slow start is not a failure (a crash after that but
 * before beginRun is the watchdog's to report, src/exits.ts recoverTaskRuns).
 * Cancellation or tmux failing mid-check closes the run and kills the pane:
 * a launch that did not succeed leaves nothing running.
 */
export async function confirmLaunch(project: string, id: string, run: string, pane: string, supervised: boolean, signal?: AbortSignal, waitMs = LAUNCH_WAIT_MS): Promise<void> {
  try {
    await awaitLaunch(project, id, run, pane, supervised, Date.now() + waitMs, signal);
  } catch (error) {
    if (error instanceof LaunchFailed) throw error;
    await claim(project, id, run).catch(() => false);
    await tmux.killPane(pane).catch(() => {});
    throw error;
  }
}

export const local: Runner = {
  async start(opts) {
    need("git");
    need("tmux");
    if (opts.role !== "orchestrator" && !opts.branch) throw new Error("workers and reviewers require a task branch");
    if (opts.role === "orchestrator" && opts.branch) throw new Error("the orchestrator runs in the original checkout, without a task branch");
    if (opts.role === "orchestrator") await assertMainCheckout(opts.project);
    let cwd: string;
    if (opts.branch) {
      cwd = await ensureWorktree(opts.project, opts.branch, opts.signal);
    } else {
      cwd = paths.repo(opts.project);
      if (!existsSync(cwd)) throw new Error(`runner: repo not found at ${cwd}`);
    }
    const session = sessionName(opts.project);
    await tmux.ensureSession(session, paths.repo(opts.project), opts.signal);
    await tmux.checkServer(opts.signal);
    const id = sessionId(opts.role, opts.branch);
    const run = opts.run ?? crypto.randomUUID();
    if (!opts.run) publishLaunch(opts.project, id, run);
    const launch = await launchEnvironment(opts.project, agentCommand(opts, run));
    let pane: string;
    try { pane = await tmux.openWindow(session, windowName(opts.role, opts.branch), cwd, launch.argv, opts.signal); }
    catch (error) { await launch.cleanup(); throw error; }
    await confirmLaunch(opts.project, id, run, pane, opts.role !== "orchestrator" && !!opts.branch, opts.signal);
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
