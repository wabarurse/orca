// Starts agents. v1 has one backend: a git worktree plus a tmux window on this
// machine. A docker/container backend comes later with the same interface, so
// agents never learn anything about the host beyond their cwd.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";
import { paths } from "./config";
import type { Role } from "./transcript";

export interface StartOptions {
  project: string;
  role: Role;
  taskId?: string;
  /** Branch to create the worktree on. Omitted for the orchestrator, which runs in repo/. */
  branch?: string;
}

export interface Runner {
  /** Create the worktree if needed and start `parallels agent` in a tmux window. */
  start(opts: StartOptions): Promise<void>;
  /** Remove the worktree and close the window. */
  stop(project: string, taskId: string): Promise<void>;
}

const CLI = resolve(import.meta.dir, "cli.ts");

function need(bin: string): string {
  const found = Bun.which(bin);
  if (!found) throw new Error(`runner: ${bin} not found on PATH`);
  return found;
}

/** Single-quote a string for a POSIX shell. */
function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export const sessionName = (project: string) => `parallels-${project}`;
export const windowName = (role: Role, taskId?: string) =>
  role === "orchestrator" ? "orchestrator" : `${role}-${taskId}`;

// --- git ---------------------------------------------------------------------

/**
 * Ensure a worktree for `taskId` exists at paths.worktree() on `branch`,
 * creating the branch from the repo's HEAD if needed. Reusing an existing
 * worktree is how a reviewer shares the worker's checkout.
 */
export async function ensureWorktree(project: string, taskId: string, branch: string): Promise<string> {
  need("git");
  const repo = paths.repo(project);
  const dir = paths.worktree(project, taskId);
  if (existsSync(dir)) return dir;
  if (!existsSync(repo)) throw new Error(`runner: repo not found at ${repo}`);

  const exists = (await $`git -C ${repo} rev-parse --verify --quiet refs/heads/${branch}`.quiet().nothrow()).exitCode === 0;
  const res = exists
    ? await $`git -C ${repo} worktree add ${dir} ${branch}`.quiet().nothrow()
    : await $`git -C ${repo} worktree add -b ${branch} ${dir} HEAD`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`runner: git worktree add failed: ${res.stderr.toString().trim()}`);
  return dir;
}

export async function removeWorktree(project: string, taskId: string): Promise<void> {
  need("git");
  const repo = paths.repo(project);
  const dir = paths.worktree(project, taskId);
  if (existsSync(dir)) {
    const res = await $`git -C ${repo} worktree remove --force ${dir}`.quiet().nothrow();
    if (res.exitCode !== 0) throw new Error(`runner: git worktree remove failed: ${res.stderr.toString().trim()}`);
  }
  await $`git -C ${repo} worktree prune`.quiet().nothrow();
}

// --- tmux --------------------------------------------------------------------

export const tmux = {
  async hasSession(session: string): Promise<boolean> {
    need("tmux");
    return (await $`tmux has-session -t ${"=" + session}`.quiet().nothrow()).exitCode === 0;
  },

  /** Create the session detached if missing. Its first window is an idle shell so the session outlives agent windows. */
  async ensureSession(session: string, cwd: string): Promise<void> {
    if (await tmux.hasSession(session)) return;
    const res = await $`tmux new-session -d -s ${session} -n shell -c ${cwd}`.quiet().nothrow();
    if (res.exitCode !== 0) throw new Error(`runner: tmux new-session failed: ${res.stderr.toString().trim()}`);
  },

  /** Open a named window in `session` running `command` (a shell string) in `cwd`. */
  async openWindow(session: string, name: string, cwd: string, command: string): Promise<void> {
    need("tmux");
    const res = await $`tmux new-window -d -t ${"=" + session} -n ${name} -c ${cwd} ${command}`.quiet().nothrow();
    if (res.exitCode !== 0) throw new Error(`runner: tmux new-window failed: ${res.stderr.toString().trim()}`);
  },

  async listWindows(session: string): Promise<string[]> {
    if (!(await tmux.hasSession(session))) return [];
    const out = await $`tmux list-windows -t ${"=" + session} -F ${"#{window_name}"}`.quiet().nothrow();
    return out.stdout.toString().split("\n").filter(Boolean);
  },

  async killWindow(session: string, name: string): Promise<void> {
    await $`tmux kill-window -t ${`=${session}:=${name}`}`.quiet().nothrow();
  },

  async killSession(session: string): Promise<void> {
    await $`tmux kill-session -t ${"=" + session}`.quiet().nothrow();
  },
};

// --- runner ------------------------------------------------------------------

export function agentCommand(opts: StartOptions): string {
  const parts = ["bun", q(CLI), "agent", "--project", q(opts.project), "--role", q(opts.role)];
  if (opts.taskId) parts.push("--task", q(opts.taskId));
  return `PARALLELS_HOME=${q(paths.root)} ${parts.join(" ")}`;
}

export const local: Runner = {
  async start(opts) {
    need("git");
    need("tmux");
    let cwd: string;
    if (opts.branch) {
      if (!opts.taskId) throw new Error("runner: taskId is required when branch is set");
      cwd = await ensureWorktree(opts.project, opts.taskId, opts.branch);
    } else {
      cwd = paths.repo(opts.project);
      if (!existsSync(cwd)) throw new Error(`runner: repo not found at ${cwd}`);
    }
    const session = sessionName(opts.project);
    await tmux.ensureSession(session, paths.repo(opts.project));
    await tmux.openWindow(session, windowName(opts.role, opts.taskId), cwd, agentCommand(opts));
  },

  async stop(project, taskId) {
    const session = sessionName(project);
    for (const name of await tmux.listWindows(session)) {
      if (name.endsWith(`-${taskId}`)) await tmux.killWindow(session, name);
    }
    await removeWorktree(project, taskId);
  },
};
