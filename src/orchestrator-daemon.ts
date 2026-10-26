// The orchestrator as a long-lived process: `orca agent --role orchestrator`
// runs this loop in the `orchestrator` window of the project's tmux session,
// so turns, rolling memory, the exit watchdog and the merge watcher go on when
// no TUI is open. TUIs are clients (src/orchestrator-client.ts): they enqueue
// input and requests through files (src/orchestrator-channel.ts) and follow
// the transcript from disk. Only this process appends to the orchestrator's
// transcript; it owns the turn locks while it does. One daemon per project:
// the daemon lock (paths.daemonLock) is held for the process's lifetime.

import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentOptions } from "./agent";
import { takeCancellation } from "./cancellation";
import { exitWatchdog, mergeWatch } from "./commands";
import { paths } from "./config";
import { claim, supervise, type Tracker } from "./exits";
import { contextWindow } from "./model-context";
import { effectiveModel } from "./project-model";
import { createOrchestrator, type Orchestrator } from "./orchestrator";
import { acknowledge, pruneAcks, takeRequests, writeStatus, type Command, type DaemonState, type Request } from "./orchestrator-channel";
import { SETTLED_EXIT } from "./runner";
import { tryStorageLock } from "./storage-lock";

/** How often the idle loop looks for input and requests when nothing woke it earlier, and how often a running turn checks for a cancel. */
export const DAEMON_POLL_MS = 1000;
const CANCEL_POLL_MS = 100;
/** The watchers' period (the merge watcher throttles itself further to MERGE_POLL_MS). */
export const WATCH_MS = 2000;

export interface DaemonOptions {
  project: string;
  run: string;
  session: Orchestrator;
  /** Exit watchdog and merge watcher; production uses commands.ts's. */
  watchers?: { watchdog?: (project: string) => Promise<unknown>; merges?: (project: string) => Promise<unknown> };
  pollMs?: number;
  watchMs?: number;
  /** Idle wait; the default sleeps until the inbox or command directory changes, or `ms` passes. Tests inject a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop once nothing is pending (the one-shot probe/test mode); production runs until told to stop. */
  exitWhenIdle?: boolean;
  /** Whether the project is gone (deleted underneath): the loop ends. */
  gone?: () => boolean;
  log?: (text: string) => void;
}
export type DaemonOutcome = "stopped" | "deleted" | "idle";

type Settled = Required<Omit<DaemonOptions, "watchers" | "exitWhenIdle">> & Pick<DaemonOptions, "exitWhenIdle">;
interface Daemon {
  o: Settled;
  watchdog: (project: string) => Promise<unknown>;
  merges: (project: string) => Promise<unknown>;
  watchedAt: number;
  turns: number;
  context?: { model: string; used?: number; window: ReturnType<typeof contextWindow> };
  error?: string;
}

/**
 * A sleep that ends early when something lands in one of `dirs`. The watchers
 * live across sleeps, so a change between two sleeps is not missed (it ends the
 * next sleep at once). Best effort: a directory that cannot be watched only
 * loses the early wake, and the poll interval still applies.
 */
export function watchedSleep(dirs: string[]): { sleep: (ms: number) => Promise<void>; close: () => void } {
  let dirty = false, wake: (() => void) | undefined;
  const changed = () => { dirty = true; wake?.(); };
  const watchers = dirs.flatMap(dir => {
    try { mkdirSync(dir, { recursive: true }); const w = watch(dir, { persistent: false }, changed); w.on("error", () => {}); return [w]; }
    catch { return []; }
  });
  return {
    sleep: ms => new Promise<void>(resolve => {
      if (dirty) { dirty = false; return resolve(); }
      const timer = setTimeout(() => { wake = undefined; resolve(); }, ms);
      wake = () => { clearTimeout(timer); wake = undefined; dirty = false; resolve(); };
    }),
    close: () => { for (const w of watchers) w.close(); },
  };
}

async function publish(d: Daemon, state: DaemonState): Promise<void> {
  await writeStatus(d.o.project, { pid: process.pid, run: d.o.run, state, since: new Date().toISOString(), turns: d.turns,
    ...(d.context ? { context: d.context } : {}), ...(d.error ? { error: d.error } : {}) }).catch(error => d.o.log(`orchestrator: could not publish status: ${error}`));
}

/** The header's estimate after a turn, from the session that just ran it. */
async function contextEstimate(d: Daemon): Promise<void> {
  const model = await effectiveModel(d.o.project).catch(() => undefined);
  if (!model) return;
  d.context = { model, used: d.o.session.contextUsage?.(model), window: d.o.session.contextWindow?.(model) ?? contextWindow({}, model) };
}

async function runCommand(d: Daemon, command: Command): Promise<string> {
  const { session, project } = d.o;
  switch (command.kind) {
    case "compact": await session.compact?.(); return "compaction requested; it runs at the next safe boundary";
    case "clear": await session.clear?.(); return "model context cleared";
    case "model": {
      const saved = await effectiveModel(project);
      if (saved !== command.model) throw new Error(`the saved model is ${saved}, not ${command.model}`);
      return `model ${saved} applies from the orchestrator's next request`;
    }
    case "stop": return "stopping";
  }
}

/** Answer every queued request in order; true when one of them was a stop. */
async function handleRequests(d: Daemon): Promise<boolean> {
  let stop = false;
  for (const r of await takeRequests(d.o.project)) {
    let ok = true, message: string;
    try { message = await runCommand(d, r.command); }
    catch (error) { ok = false; message = error instanceof Error ? error.message : String(error); }
    await acknowledge(d.o.project, r.id, ok, message).catch(error => d.o.log(`orchestrator: could not acknowledge ${r.command.kind}: ${error}`));
    if (r.command.kind === "stop" && ok) stop = true;
  }
  return stop;
}

/** A cancel request for this launch: abort/pause the session and answer under its token. */
async function takeCancel(d: Daemon): Promise<boolean> {
  const token = takeCancellation(d.o.project, "orchestrator", d.o.run);
  if (!token) return false;
  d.o.session.cancel?.();
  await acknowledge(d.o.project, token, true, "turn cancelled; the orchestrator stays paused until you send a message").catch(error => d.o.log(`orchestrator: could not acknowledge the cancel: ${error}`));
  return true;
}

async function runWatchers(d: Daemon): Promise<void> {
  const now = d.o.now();
  if (now - d.watchedAt < d.o.watchMs) return;
  d.watchedAt = now;
  await Promise.all([d.watchdog, d.merges].map(w => w(d.o.project).catch(error => d.o.log(`orchestrator: watcher failed: ${error}`))));
}

/** One turn with its own cancel poll; a failed turn is published, never fatal (input stays, the next message resumes). */
async function runTurn(d: Daemon): Promise<void> {
  d.turns++;
  d.error = undefined;
  await publish(d, "turn");
  const poll = setInterval(() => { void takeCancel(d); }, CANCEL_POLL_MS);
  try { await d.o.session.turn(); }
  catch (error) {
    d.error = error instanceof Error ? error.message : String(error);
    d.o.log(`orchestrator: turn failed: ${d.error}; send another message to resume with retained history`);
  } finally { clearInterval(poll); }
  await contextEstimate(d);
  await publish(d, "idle");
}

/** One pass of the loop: requests, an idle cancel, the watchers, then a turn or a wait. */
async function step(d: Daemon): Promise<DaemonOutcome | undefined> {
  if (d.o.gone()) return "deleted";
  if (await handleRequests(d)) return "stopped";
  await takeCancel(d);
  await runWatchers(d);
  if (await d.o.session.pending()) { await runTurn(d); return; }
  if (d.o.exitWhenIdle) return "idle";
  await d.o.sleep(d.o.pollMs);
}

/** Run the loop until a stop request, project deletion or (exitWhenIdle) nothing left to do. */
export async function runDaemon(options: DaemonOptions): Promise<DaemonOutcome> {
  const { project } = options;
  const watched = options.sleep ? undefined : watchedSleep([join(paths.inbox(project), "orchestrator"), join(paths.orchestrator(project), "commands"), dirname(paths.transcript(project, "orchestrator"))]);
  const d: Daemon = {
    o: { pollMs: DAEMON_POLL_MS, watchMs: WATCH_MS, now: Date.now, log: text => console.error(text),
      gone: () => !existsSync(paths.project(project)), ...options, sleep: options.sleep ?? watched!.sleep },
    watchdog: options.watchers?.watchdog ?? exitWatchdog(),
    merges: options.watchers?.merges ?? mergeWatch(),
    watchedAt: -Infinity, turns: 0,
  };
  try {
    await pruneAcks(project);
    await publish(d, "idle");
    for (;;) {
      // A project removed mid-step fails the step (its files vanish under it): that is deletion, not a crash.
      const outcome = await step(d).catch(error => { if (d.o.gone()) return "deleted" as const; throw error; });
      if (!outcome) continue;
      if (outcome !== "deleted") await publish(d, "stopped");
      return outcome;
    }
  } finally { watched?.close(); }
}

/**
 * `orca agent --role orchestrator`: one daemon per project, supervised like a
 * worker (run record, exit notice on a crash or a signal). A clean stop closes
 * its own run first, so no notice follows it; a project deleted underneath ends
 * the process at once, so nothing writes its files back. Returns the exit code.
 */
export async function orchestratorAgent(opts: AgentOptions & { run: string }, exit: (code: number) => void = code => process.exit(code)): Promise<number> {
  const { project, run } = opts;
  const release = await tryStorageLock(paths.daemonLock(project), project);
  if (!release) { console.error(`orca: an orchestrator is already running for ${project}`); return SETTLED_EXIT; }
  const info = { project, id: "orchestrator", run, role: "orchestrator" as const, cwd: process.cwd() };
  try {
    return await supervise(info, async (tracker: Tracker) => {
      const session = await createOrchestrator({ project, loadProvider: opts.loadProvider, rolling: opts.rolling, tracker, joinRolling: opts.exitWhenIdle });
      let outcome: DaemonOutcome;
      try { outcome = await runDaemon({ project, run, session, exitWhenIdle: opts.exitWhenIdle }); }
      finally { session.dispose?.(); }
      if (outcome === "deleted") { await release(); exit(0); return new Promise<never>(() => {}); } // nothing after a real exit
      await claim(project, "orchestrator", run); // a clean stop is not an exit to report
    });
  } finally { await release(); }
}
