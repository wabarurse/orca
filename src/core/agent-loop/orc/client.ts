// The TUI's side of the orchestrator daemon (src/core/agent-loop/orc/daemon.ts): make
// sure one runs, hand it input and requests through files, follow its turns
// and the transcript from disk, and stop it for project deletion. Nothing here
// calls a model or appends to the orchestrator's transcript.

import { existsSync } from "node:fs";
import { cancelSession, delay } from "../../tmux";
import { loadConfig, paths } from "../../../config";
import { pendingImageInputs } from "../../data/images";
import type { ImageRef } from "../../../protocol";
import { pendingInput, put } from "../../data/inbox";
import { contextWindow } from "../../../providers/catalog";
import type { Orchestrator } from "./orchestrator";
import { awaitAck, daemonPid, liveStatus, readStatus, request } from "./channel";
import type { DaemonStatus } from "../../../protocol";
import { liveReader, type LiveReader } from "./live";
import type { LiveEvent } from "../../../protocol";
import { projectIdentity, turnLocksHeld } from "../../data/projects";
import { local, sessionName, tmux, type Runner } from "../../tmux";
import { pidAlive } from "../../data";
import type { ToolCall, ToolOutcome } from "../../../protocol";
import { open, type Transcript } from "../../data/transcripts";
import { inputEpoch } from "../../data/inbox";

/** How often a following client looks at the status and transcript. */
export const FOLLOW_MS = 250;
/** How often it tails the live file between those looks while a turn runs (twice per look). */
export const LIVE_MS = 125;
/** How long a turn started by this client's own send waits for the daemon to pick the input up. */
export const START_GRACE_MS = 5000;
/** After a dead daemon is restarted, how long before the keeper tries again. */
export const RESTART_BACKOFF_MS = 15_000;
/** How long project deletion waits for a stop request, then for a killed window. */
export const STOP_WAIT_MS = 10_000;
const KILL_WAIT_MS = 3000;

export interface EnsureOptions { runner?: Runner; signal?: AbortSignal; alive?: (project: string) => Promise<boolean> }

/** Start the project's daemon unless one is alive. A launch lost to a concurrent start (the loser exits before its run record) counts as running. */
export async function ensureDaemon(project: string, opts: EnsureOptions = {}): Promise<"running" | "started"> {
  const alive = opts.alive ?? (async (p: string) => (await daemonPid(p)) !== undefined);
  if (await alive(project)) return "running";
  try { await (opts.runner ?? local).start({ project, role: "orchestrator", signal: opts.signal }); }
  catch (error) {
    if (await alive(project)) return "running";
    throw error;
  }
  return "started";
}

/**
 * The TUI's per-poll check: a dead daemon is restarted at most once per
 * RESTART_BACKOFF_MS per project. Returns a line to show when something
 * happened (a restart, not the first start); throws when a start failed (the next poll tries again after the backoff).
 */
export function daemonKeeper(opts: EnsureOptions & { now?: () => number } = {}): (project: string) => Promise<string | undefined> {
  const now = opts.now ?? Date.now;
  const started = new Map<string, number>();
  const checking = new Map<string, Promise<string | undefined>>();
  return project => {
    const pending = checking.get(project);
    if (pending) return pending;
    const check = (async () => {
      const last = started.get(project);
      if (last !== undefined && now() - last < RESTART_BACKOFF_MS) return;
      const alive = opts.alive ?? (async (p: string) => (await daemonPid(p)) !== undefined);
      if (await alive(project)) return;
      started.set(project, now());
      await ensureDaemon(project, opts);
      return last === undefined ? undefined : "orchestrator was not running; restarted"; // the first start is routine: nothing to show
    })().finally(() => checking.delete(project));
    checking.set(project, check);
    return check;
  };
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
  return true;
}

/** Ask the daemon to stop and wait for its process to end; kill its window if it does not; throw if it lives on. */
export async function stopDaemon(project: string, opts: { kill?: (project: string) => Promise<void>; waitMs?: number; killWaitMs?: number } = {}): Promise<void> {
  const pid = await daemonPid(project);
  if (pid === undefined) return;
  await request(project, { kind: "stop" });
  if (await waitDead(pid, opts.waitMs ?? STOP_WAIT_MS)) return;
  await (opts.kill ?? (async (p: string) => { if (Bun.which("tmux")) await tmux.killWindow(sessionName(p), "orchestrator"); }))(project);
  if (!await waitDead(pid, opts.killWaitMs ?? KILL_WAIT_MS)) throw new Error(`orchestrator (pid ${pid}) did not stop; stop it, then delete`);
}

// --- the client Orchestrator ---------------------------------------------------

export interface ClientDeps {
  project: string;
  /** The transcript has new entries (idle or mid-turn): the TUI re-syncs from disk, dropping what the live events below showed (durable entries supersede them). */
  onRefresh?: () => void;
  /** Acknowledgements and failures the user should see. */
  notice?: (text: string) => void;
  /** The daemon's live events while a turn runs (src/core/agent-loop/orc/live.ts), as the in-process hooks got them: streamed text (`plain` for status lines), a tool starting and ending. */
  write?: (text: string, plain?: boolean) => void;
  onTool?: (call: ToolCall) => void;
  onToolResult?: (outcome: ToolOutcome) => void;
  transcript?: Transcript;
  put?: typeof put;
  cancel?: typeof cancelSession;
  /** The live daemon's status (none when it is dead); tests inject it. */
  status?: (project: string) => Promise<DaemonStatus | undefined>;
  alive?: (project: string) => Promise<boolean>;
  followMs?: number;
  liveMs?: number;
  graceMs?: number;
}

interface Follow { seen: string | null; turnsAt: number; engaged: boolean; abort: AbortController; live: LiveReader; status?: DaemonStatus }

/** What a client shares between its methods. */
interface Client {
  project: string;
  transcript: Transcript;
  deps: ClientDeps;
  status: (project: string) => Promise<DaemonStatus | undefined>;
  alive: () => Promise<boolean>;
  notice: (text: string) => void;
  checkIdentity: () => void;
  following?: Follow;
  disposed: boolean;
}

const busy = async (c: Client) => (await c.status(c.project))?.state === "turn";

/** Reload the transcript; a new head is handed to the TUI to re-sync from disk. */
async function sync(c: Client, f: Follow): Promise<void> {
  await c.transcript.refresh?.();
  const head = c.transcript.head();
  if (head !== f.seen) { f.seen = head; c.deps.onRefresh?.(); }
}

/** One live event to the view, through the hooks the in-process turn used. Status lines (memory-index warnings and the like) are page notices: they outlive the re-renders a turn's entries cause. */
function show(c: Client, e: Exclude<LiveEvent, { kind: "start" }>): void {
  switch (e.kind) {
    case "text": c.deps.write?.(e.text); break;
    case "status": for (const line of e.text.replace(/\n$/, "").split("\n")) c.notice(line); break;
    case "tool_start": c.deps.onTool?.(e.call); break;
    case "tool_end": c.deps.onToolResult?.(e.outcome); break;
    case "truncated": c.notice("orchestrator: live output truncated (over 1 MiB this turn); the full text shows when the turn ends"); break;
  }
}

/**
 * The live events appended since the last look. An event tagged with the
 * transcript head the view shows is ahead of the record and goes to the view;
 * one tagged with another head is behind a durable entry (the daemon appends,
 * then tags with the new head), so the first such event re-syncs the view once
 * and whatever is still not at the head is superseded by what that sync showed.
 */
async function tailLive(c: Client, f: Follow, s: DaemonStatus): Promise<void> {
  let synced = false;
  for (const e of f.live.read({ run: s.run, turn: s.turns })) {
    if (e.kind === "start") continue;
    if (e.head !== f.seen && !synced) { synced = true; await sync(c, f); }
    if (e.head === f.seen) show(c, e);
  }
}

/** Between two looks: tail the live file every liveMs (followMs split evenly, 2 × 125ms by default) while a turn runs. */
async function pause(c: Client, f: Follow): Promise<void> {
  const followMs = c.deps.followMs ?? FOLLOW_MS;
  const ticks = Math.max(1, Math.floor(followMs / Math.min(c.deps.liveMs ?? LIVE_MS, followMs)));
  for (let i = 0; i < ticks; i++) {
    await delay(followMs / ticks, f.abort.signal);
    if (f.status?.state === "turn") await tailLive(c, f, f.status);
  }
}

/** One look while following: "dead", "done" (the followed turn ended), "none" (nothing started within the grace) or "wait". */
async function observe(c: Client, f: Follow, deadline: number): Promise<"dead" | "done" | "none" | "wait"> {
  await sync(c, f);
  const s = f.status = await c.status(c.project);
  if (!s) return "dead";
  if (s.turns > f.turnsAt || s.state === "turn") f.engaged = true;
  if (f.engaged && s.state !== "turn") {
    await sync(c, f); // what the turn appended after the first look
    if (s.error) c.notice(`orchestrator: turn failed: ${s.error}; send another message to resume with retained history`);
    return "done";
  }
  return !f.engaged && Date.now() >= deadline ? "none" : "wait";
}

/** Wait until the daemon's turn ends (or none starts within the grace), re-syncing as the transcript grows. A turn that began and ended between two looks still counts (the turn counter). */
async function follow(c: Client): Promise<void> {
  const f: Follow = { seen: c.transcript.head(), turnsAt: 0, engaged: false, abort: new AbortController(), live: liveReader(c.project, c.notice) };
  c.following = f; // before the first await: pending() must not schedule a second follow meanwhile
  const deadline = Date.now() + (c.deps.graceMs ?? START_GRACE_MS);
  try {
    const start = await c.status(c.project);
    f.turnsAt = start?.turns ?? 0;
    f.engaged = start?.state === "turn";
    while (await observe(c, f, deadline) === "wait") await pause(c, f);
  } catch (error) {
    if (!f.abort.signal.aborted) throw error;
  } finally { c.following = undefined; }
}

/** Send a request (or cancel) and wait for the daemon's answer; a refusal is thrown with the daemon's reason. */
async function ask(c: Client, what: string, send: () => Promise<string | undefined>, signal?: AbortSignal): Promise<string> {
  c.checkIdentity();
  if (!await c.alive()) throw new Error("orchestrator is not running");
  const id = await send();
  if (!id) throw new Error(`orchestrator has no launch to ${what}`);
  const ack = await awaitAck(c.project, id, { signal, alive: c.alive });
  if (!ack.ok) throw new Error(ack.message);
  return ack.message;
}

/** The client-side clear guard, from disk: the daemon rechecks under its locks. */
async function checkClear(c: Client): Promise<void> {
  c.checkIdentity();
  if (!await c.alive()) throw new Error("orchestrator is not running; wait for it to start before clearing context");
  if (c.following || await busy(c) || await turnLocksHeld(c.project)) throw new Error("orchestrator is running or compacting; wait before clearing context");
  if ((await pendingImageInputs(c.project, c.transcript.consumed?.().inputs)).length) throw new Error("image input is pending; retry it before clearing context");
  if (await pendingInput(c.project, "orchestrator")) throw new Error("input is pending; context was not cleared");
}

/** The last turn's estimate for this model, from the daemon's status. */
function contextOf(project: string, model: string): DaemonStatus["context"] | undefined {
  const context = readStatus(project)?.context;
  return context?.model === model ? context : undefined;
}

async function say(c: Client, text: string, submission: string, inputId?: string, attachments?: ImageRef[]): Promise<void> {
  c.checkIdentity();
  await (c.deps.put ?? put)(c.project, "orchestrator", { from: "user", text, ...(attachments?.length ? { attachments } : {}), userEpoch: submission, ...(inputId ? { inputId } : {}) });
}

/** The request goes out at once; the daemon's answer (or its absence) is reported when it comes. */
function cancel(c: Client): void {
  void ask(c, "cancel", () => (c.deps.cancel ?? cancelSession)(c.project, "orchestrator"))
    .then(message => c.notice(`orchestrator: ${message}`), error => c.notice(`cancel not acknowledged: ${error instanceof Error ? error.message : error}`));
}

function client(deps: ClientDeps): Client {
  const { project } = deps;
  const identity = existsSync(paths.project(project)) ? projectIdentity(project) : undefined;
  const alive = deps.alive ?? (async (p: string) => (await daemonPid(p)) !== undefined);
  return {
    project, deps, transcript: deps.transcript ?? open(paths.transcript(project, "orchestrator")),
    status: deps.status ?? liveStatus, alive: () => alive(project), notice: deps.notice ?? (() => {}), disposed: false,
    checkIdentity: () => { if (identity && projectIdentity(project) !== identity) throw new Error("project changed; reopen it before continuing"); },
  };
}

/**
 * An Orchestrator for the TUI that runs nothing itself: `say` publishes to the
 * inbox, `turn` follows the daemon's turn (status.json) while re-syncing the
 * transcript, `cancel`/`clear`/`compact`/`observeModel` go through the channel
 * and report the daemon's acknowledgement.
 */
export async function createClientOrchestrator(deps: ClientDeps): Promise<Orchestrator> {
  const { project } = deps;
  const config = await loadConfig();
  const c = client(deps);
  return {
    contextUsage: model => contextOf(project, model)?.used,
    contextWindow: model => contextOf(project, model)?.window ?? contextWindow({ fallback: config.contextLimitFallback }, model),
    submission: () => inputEpoch(project),
    say: (text, submission = inputEpoch(project), inputId, attachments) => say(c, text, submission, inputId, attachments),
    pending: async () => !c.disposed && !c.following && await busy(c),
    turn: async () => { if (!c.disposed && !c.following) await follow(c); return []; },
    cancel: () => cancel(c),
    compact: async () => { c.notice(`orchestrator: ${await ask(c, "compact", () => request(project, { kind: "compact" }))}`); },
    checkClear: () => checkClear(c),
    clear: async signal => { await checkClear(c); await ask(c, "clear", () => request(project, { kind: "clear" }), signal); await c.transcript.refresh?.(); },
    observeModel: model => ask(c, "model", () => request(project, { kind: "model", model })),
    entries: () => c.transcript.history?.() ?? c.transcript.branch(),
    consumed: () => c.transcript.consumed?.().inputs ?? new Set(),
    refresh: async () => { if (c.following) return false; c.checkIdentity(); await c.transcript.refresh?.(); return !c.following; },
    dispose: () => { c.disposed = true; c.following?.abort.abort(new Error("page closed")); },
  };
}
