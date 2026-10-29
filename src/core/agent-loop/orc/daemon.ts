import { reconcileProcesses } from "../../data/processes";
// The orchestrator as a long-lived process: `orca agent --role orchestrator`
// (exec/daemon.ts) runs this loop in the `orchestrator` window of the project's
// tmux session, so turns, rolling memory, the exit watchdog and the merge watcher
// go on when no TUI is open. TUIs are clients (src/core/agent-loop/orc/client.ts):
// they enqueue input and requests through files (src/core/agent-loop/orc/channel.ts)
// and follow the transcript from disk. Only this process appends to the
// orchestrator's transcript; it owns the turn locks while it does. One daemon per
// project: the daemon lock (paths.daemonLock) is held for the process's lifetime.

import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { delay, launchIdentity, publishLaunch, takeCancellation } from "../../tmux";
import { exitWatchdog, mergeWatch } from "../../tmux";
import { paths, repositoryBinding, BUILD_ID } from "../../../config";
import { contextWindow } from "../../../providers/catalog";
import { effectiveModel } from "../../data/projects";
import type { Orchestrator, OrchestratorDeps } from "./orchestrator";
import { acknowledge, pruneAcks, takeRequests, writeStatus } from "./channel";
import type { Command, DaemonState, Request } from "../../../protocol";
import type { LiveWriter } from "./live";
import { callText, resultText } from "../../../protocol";

/** How often the idle loop looks for input and requests when nothing woke it earlier, and how often a running turn checks for a cancel or an in-turn request. */
export const DAEMON_POLL_MS = 1000;
export const TURN_POLL_MS = 100;
/** Requests a running turn can answer: compaction is a flag the turn reads at its next safe boundary, a model change is read at the next request. */
const IN_TURN = new Set<Command["kind"]>(["compact", "model"]);
/** The watchers' period (the merge watcher throttles itself further to MERGE_POLL_MS). */
export const WATCH_MS = 2000;
/** The acknowledgements of a cancel and of a /compact request; the client prefixes "orchestrator: " and the TUI shows them as transient notes (tui/conversation/notices.ts). */
export const CANCEL_ACK = { turn: "turn cancelled; the orchestrator stays paused until you send a message", idle: "nothing was running; queued input stays paused until you send a message" } as const;
export const COMPACT_ACK = "compaction requested; it runs at the next safe boundary";

export interface DaemonOptions {
  project: string;
  run: string;
  session: Orchestrator;
  /** Exit watchdog and merge watcher; production uses liveness.ts's. */
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
  /** The turn's live side channel (src/core/agent-loop/orc/live.ts): begun with each turn, ended once its entries are durable. The session's hooks feed the same writer. */
  live?: Pick<LiveWriter, "begin" | "end">;
}
export type DaemonOutcome = "stopped" | "deleted" | "idle";

type Settled = Required<Omit<DaemonOptions, "watchers" | "exitWhenIdle" | "live">> & Pick<DaemonOptions, "exitWhenIdle" | "live">;
interface Daemon {
  o: Settled;
  watchdog: (project: string) => Promise<unknown>;
  merges: (project: string) => Promise<unknown>;
  watchedAt: number;
  /** The watcher pass in flight (never rejects); input never waits for it. */
  watching?: Promise<void>;
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
  await writeStatus(d.o.project, { build: BUILD_ID, pid: process.pid, run: d.o.run, state, since: new Date().toISOString(), turns: d.turns,
    ...(d.context ? { context: d.context } : {}), ...(d.error ? { error: d.error } : {}) }).catch(error => d.o.log(`orchestrator: could not publish status: ${error}`));
}

/** The header's estimate after a turn, from the session that just ran it. */
async function contextEstimate(d: Daemon): Promise<void> {
  const model = await effectiveModel(d.o.project, "orchestrator").catch(() => undefined);
  if (!model) return;
  d.context = { model, used: d.o.session.contextUsage?.(model), window: d.o.session.contextWindow?.(model) ?? contextWindow({}, model) };
}

async function runCommand(d: Daemon, command: Command): Promise<string> {
  const { session, project } = d.o;
  switch (command.kind) {
    case "compact": await session.compact?.(); return COMPACT_ACK;
    case "clear": await session.clear?.(); return "model context cleared";
    // Confirms what is saved now: an older request overtaken by a newer switch still gets the current answer, not an error.
    case "model": return `model ${await effectiveModel(project, "orchestrator")} applies from the orchestrator's next request`;
    case "stop": return "stopping";
  }
}

/** Answer the queued requests `accept` takes, in order; true when one of them was a stop. */
async function handleRequests(d: Daemon, accept?: (kind: Command["kind"]) => boolean): Promise<boolean> {
  let stop = false;
  for (const r of await takeRequests(d.o.project, accept)) {
    if (r.run && r.run !== d.o.run) {
      await acknowledge(d.o.project, r.id, false, "request belongs to an earlier daemon run")
        .catch(error => d.o.log(`orchestrator: could not acknowledge stale request: ${error}`));
      continue;
    }
    let ok = true, message: string;
    try { message = await runCommand(d, r.command); }
    catch (error) { ok = false; message = error instanceof Error ? error.message : String(error); }
    await acknowledge(d.o.project, r.id, ok, message).catch(error => d.o.log(`orchestrator: could not acknowledge ${r.command.kind}: ${error}`));
    if (r.command.kind === "stop" && ok) stop = true;
  }
  return stop;
}

/** A cancel request for this launch: abort/pause the session and answer under its token. */
async function takeCancel(d: Daemon, inTurn: boolean): Promise<boolean> {
  const token = takeCancellation(d.o.project, "orchestrator", d.o.run);
  if (!token) return false;
  d.o.session.cancel?.();
  const what = inTurn ? CANCEL_ACK.turn : CANCEL_ACK.idle;
  await acknowledge(d.o.project, token, true, what).catch(error => d.o.log(`orchestrator: could not acknowledge the cancel: ${error}`));
  return true;
}

/** This launch's identity, so a cancel from any client names this run; a concurrent start that lost the lock may have published its own after ours. */
function assertLaunch(d: Daemon): void {
  if (launchIdentity(d.o.project, "orchestrator") !== d.o.run) publishLaunch(d.o.project, "orchestrator", d.o.run);
}

/** While a turn runs: cancels and in-turn requests every TURN_POLL_MS, one pass at a time. */
async function pollTurn(d: Daemon, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (!d.o.gone()) assertLaunch(d);
    await takeCancel(d, true);
    await handleRequests(d, kind => IN_TURN.has(kind));
    await delay(TURN_POLL_MS, signal).catch(() => {});
  }
}

/** Start a due watcher pass in the background, one at a time. The merge watcher's pass runs `gh` once per
 * active task PR (each up to 20s); awaited in `step`, it held input sent to an idle orchestrator until it ended. */
function runWatchers(d: Daemon): void {
  const now = d.o.now();
  if (d.watching || now - d.watchedAt < d.o.watchMs) return;
  d.watchedAt = now;
  const pass: Promise<void> = (async () => {
    await reconcileProcesses(d.o.project).catch(error => d.o.log(`process recovery: ${error}`));
    await Promise.all([d.watchdog, d.merges].map(w => w(d.o.project).catch(error => d.o.log(`orchestrator: watcher failed: ${error}`))));
  })().catch(error => d.o.log(`orchestrator: watcher failed: ${error}`)).finally(() => { if (d.watching === pass) d.watching = undefined; });
  d.watching = pass;
}

/** One turn with its own cancel poll; a failed turn is published, never fatal (input stays, the next message resumes). The live file spans the turn: begun before the status says `turn`, gone before it says `idle`. */
async function runTurn(d: Daemon): Promise<void> {
  d.turns++;
  d.error = undefined;
  d.o.live?.begin(d.turns);
  await publish(d, "turn");
  const polling = new AbortController();
  const poll = pollTurn(d, polling.signal);
  try { await d.o.session.turn(); }
  catch (error) {
    d.error = error instanceof Error ? error.message : String(error);
    d.o.log(`orchestrator: turn failed: ${d.error}; send another message to resume with retained history`);
  } finally { polling.abort(); await poll; }
  await d.o.live?.end(); // the turn's entries are durable now: a late client finds no live data for a finished turn
  await contextEstimate(d);
  await publish(d, "idle");
}

/** One pass of the loop: requests, an idle cancel, a due watcher pass started in the background, then a turn or a wait. */
async function step(d: Daemon): Promise<DaemonOutcome | undefined> {
  if (d.o.gone()) return "deleted";
  assertLaunch(d);
  if (await handleRequests(d)) return "stopped";
  await takeCancel(d, false);
  runWatchers(d); // not awaited: input that lands meanwhile starts its turn now
  if (await d.o.session.pending()) { await runTurn(d); return; }
  if (d.o.exitWhenIdle) {
    await d.watching; // what the watchers queued (exit and merge notices) still runs before an idle exit
    if (await d.o.session.pending()) { await runTurn(d); return; }
    return "idle";
  }
  await d.o.sleep(d.o.pollMs);
}

/** A deleted project: its directory, or its binding (SQLite repository record, or a legacy clone), is gone. The daemon's own late writes (status, acks) cannot make it look present again. */
export const projectGone = (project: string): boolean =>
  !existsSync(paths.project(project)) || (!repositoryBinding(project) && !existsSync(join(paths.project(project), "repo")));

/** Run the loop until a stop request, project deletion or (exitWhenIdle) nothing left to do. */
export async function runDaemon(options: DaemonOptions): Promise<DaemonOutcome> {
  const { project } = options;
  const watched = options.sleep ? undefined : watchedSleep([join(paths.inbox(project), "orchestrator"), join(paths.orchestrator(project), "commands"), dirname(paths.transcript(project, "orchestrator"))]);
  const d: Daemon = {
    o: { pollMs: DAEMON_POLL_MS, watchMs: WATCH_MS, now: Date.now, log: text => console.error(text),
      gone: () => projectGone(project), ...options, sleep: options.sleep ?? watched!.sleep },
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
      await d.watching;
      if (outcome !== "deleted") await publish(d, "stopped");
      return outcome;
    }
  } finally { await d.watching; watched?.close(); }
}

/** The session's output hooks: the window shows streamed text and tool lines like a worker's, and the live file gets the same events. */
export function windowHooks(live: LiveWriter, out: (text: string) => void = text => { process.stdout.write(text); }): Pick<OrchestratorDeps, "write" | "onTool" | "onToolResult"> {
  return {
    write: (text, plain) => { out(text); live.write(text, plain); },
    onTool: call => { out(`${callText(call)}\n`); live.onTool(call); },
    onToolResult: (outcome, call) => { out(`${resultText(call.name, outcome)}\n`); live.onToolResult(outcome); },
  };
}
