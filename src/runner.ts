// Starts agents. v1 has one backend: a git worktree plus a tmux window on this
// machine. A docker/container backend comes later with the same interface, so
// agents never learn anything about the host beyond their cwd.

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

// TODO(PR4): implement the tmux + worktree runner.
export const local: Runner = {
  async start() {
    throw new Error("runner: not implemented");
  },
  async stop() {
    throw new Error("runner: not implemented");
  },
};
