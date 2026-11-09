// Shared safety checks for session export and import: nothing may be running or queued for the project while
// its state is read or replaced, and only one import runs per machine.

import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { pidAlive, tryStorageLock } from "../data";
import { conversationTurnLock, withProjectStateLock } from "../data/projects";
import { command } from "../proc";
import { liveAgentsOrNull, readRun } from "../tmux";

/** Injectable boundaries: tests replace tmux liveness, pid checks and the git origin lookup, never the real ones. */
export interface TransferDeps {
  live: (project: string) => Promise<string[] | null>;
  alive: (pid: number) => boolean;
  now: () => Date;
  hostname: () => string;
  /** The raw `origin` URL of the checkout at `directory`, null when it is not a git checkout root or has no origin. */
  origin: (directory: string) => Promise<string | null>;
}

/** Only the checkout's own origin counts: a plain folder inside some other repository has none. */
async function gitOrigin(directory: string): Promise<string | null> {
  try {
    const top = await command(["git", "rev-parse", "--show-toplevel"], directory);
    if (top.code !== 0 || realpathSync(top.out.trim()) !== realpathSync(directory)) return null;
    const url = await command(["git", "remote", "get-url", "origin"], directory);
    return url.code === 0 ? url.out.trim() : null;
  } catch { return null; }
}
export const realDeps = (): TransferDeps => ({ live: liveAgentsOrNull, alive: pidAlive, now: () => new Date(), hostname, origin: gitOrigin });

const names = (dir: string) => readdir(dir).catch(e => { if ((e as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw e; });

/** Refuse unless the project is quiet. Unknown liveness is not "quiet". */
export async function assertQuiescent(project: string, deps: TransferDeps, action: string): Promise<void> {
  const live = await deps.live(project);
  if (live === null) throw new Error(`cannot ${action} ${project}: tmux could not be asked whether agents are running (liveness unknown); retry when it can be`);
  if (live.length) throw new Error(`cannot ${action} ${project}: agents are live (${live.join(", ")}); stop them or let them finish first`);
  for (const name of (await names(paths.runs(project))).filter(n => n.endsWith(".json"))) {
    const state = await readRun(project, name.slice(0, -".json".length));
    if (!state) throw new Error(`cannot ${action} ${project}: run record runs/${name} is unreadable, so its liveness is unknown`);
    if (!state.endedAt && Number.isInteger(state.pid) && deps.alive(state.pid)) throw new Error(`cannot ${action} ${project}: run ${name} is still running (pid ${state.pid})`);
  }
  for (const agent of await names(paths.inbox(project))) {
    const pending = await names(join(paths.inbox(project), agent));
    if (pending.length) throw new Error(`cannot ${action} ${project}: ${agent}'s inbox has ${pending.length} undelivered message(s); let the agent drain it first (inboxes never transfer, and it is in the agent's hands until it has read them)`);
  }
}

/** Hold the conversation turn and state locks during session transfer. */
export async function withQuietProject<T>(project: string, action: () => Promise<T>): Promise<T> {
  const release = await tryStorageLock(conversationTurnLock(project), project);
  if (!release) throw new Error(`a turn is in progress for ${project} (turn lock held); try again when it ends`);
  try { return await withProjectStateLock(project, action); }
  finally { await release(); }
}

/** One import at a time per machine: two concurrent imports would race on names, folders and the sync records. */
export async function withImportLock<T>(action: () => Promise<T>): Promise<T> {
  const release = await tryStorageLock(join(paths.runtime, "session-import.lock"));
  if (!release) throw new Error("another session import is running on this machine; try again when it finishes");
  try { return await action(); }
  finally { await release(); }
}
