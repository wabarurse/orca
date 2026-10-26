import { allTasks, startTaskRun, stopTaskRun, invalidateTaskBranch } from "../data/tasks";
import type { Task, TaskRun } from "../../protocol";
import { Cancelled } from "./cancellation";
// Exit notices: when a worker or reviewer stops without reporting, the
// orchestrator hears about it through its inbox, at most once per run.
//
// Each run of an agent (one `orca agent` process) has a run id, chosen by
// agentCommand and passed to both the agent and the shell follow-up after it.
// The agent keeps runs/<id>.json up to date: run id, pid, whether its last
// act was a report, its last step and tool. A run is closed by creating
// runs/<id>.<run>.exit exclusively: whoever creates it sends the notice, or
// none when the run ended on a report. So the senders (crash, signal, clean
// exit, shell follow-up, the daemon's watchdog, startup sweep, a failed launch in
// runner.ts and the never-started recovery below) never duplicate.

import { existsSync, mkdirSync } from "node:fs";
import { open as openFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../config";
import { pidAlive } from "../data";
import { put } from "../data/inbox";
import { run } from "../proc";
import { SETTLED_EXIT, slug } from "./runner";
import type { Role } from "../../protocol";

export interface RunState {
  run: string;
  /** The agent process, so the watchdog can confirm it is gone. */
  pid: number;
  role: Role;
  branch?: string;
  /**
   * "reported" when the agent's last act was a message to the orchestrator.
   * Any later tool call or inbox message makes it "running" again: only the
   * final report counts.
   */
  state: "running" | "reported";
  /** What it was doing last: a model request or a tool call. */
  step: string;
  /** The last tool call, kept when the step moves on to the next model request. */
  tool: string;
  /** Last update of this file. */
  ts: string;
  /** When this run started (ISO), set once by beginRun. Absent in files written before clocks existed. */
  startedAt?: string;
  /**
   * When this run was closed (ISO). Stamped by supervise (finished, reported, crashed, cancelled),
   * the signal handler and afterExit. The watchdog's sweep and merge cleanup do not stamp it:
   * a run only they close shows the file's `ts` as an approximate end (merge cleanup relies on the
   * agent's own SIGHUP handler). Absent while it runs.
   */
  endedAt?: string;
}

/** How long a notice waits for `git status`; a signal handler waits less. */
const GIT_TIMEOUT_MS = 3000;
const SIGNAL_GIT_TIMEOUT_MS = 1000;
/** Claim files older than this are pruned when a run starts. */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

const file = (project: string, id: string) => join(paths.runs(project), `${id}.json`);
const claimFile = (project: string, id: string, run: string) => join(paths.runs(project), `${id}.${run}.exit`);

export async function readRun(project: string, id: string): Promise<RunState | null> {
  try {
    return (await Bun.file(file(project, id)).json()) as RunState;
  } catch {
    return null;
  }
}

async function writeRun(project: string, id: string, s: RunState): Promise<void> {
  mkdirSync(paths.runs(project), { recursive: true });
  const path = file(project, id);
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await Bun.write(tmp, JSON.stringify(s) + "\n");
  await rename(tmp, path);
}

/**
 * Stamp `endedAt` on the stored state of run `run` when it has none yet. False when the file is another run's, already stamped, or missing.
 * This reads then rewrites the file, so a respawn's beginRun landing in between could be overwritten by
 * the old run's state: unlikely (a few ms), and it heals on the new tracker's next write.
 */
export async function markEnded(project: string, id: string, run: string, at = new Date().toISOString()): Promise<boolean> {
  const s = await readRun(project, id);
  if (!s || s.run !== run || s.endedAt) return false;
  await writeRun(project, id, { ...s, endedAt: at, ts: at });
  return true;
}

/** Close a run: true for the one caller that gets to, false if it was already closed. */
export async function claim(project: string, id: string, run: string): Promise<boolean> {
  mkdirSync(paths.runs(project), { recursive: true });
  try {
    await (await openFile(claimFile(project, id, run), "wx")).close();
    return true;
  } catch {
    return false;
  }
}

export const claimed = (project: string, id: string, run: string) => existsSync(claimFile(project, id, run));

/**
 * Uncommitted changes in `cwd` (`git status --porcelain` lines), or null when
 * unknown: not a repo, git missing, or no answer within `timeoutMs`.
 * --no-optional-locks keeps it from touching the index lock of a live agent.
 */
export async function dirtyCount(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<number | null> {
  const res = await run(["git", "--no-optional-locks", "status", "--porcelain"], { cwd, timeoutMs });
  return res && res.code === 0 ? res.out.split("\n").filter(Boolean).length : null;
}

/** One line, capped, for a notice. */
const oneLine = (s: string, max = 400) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** The notice text: what happened plus what the orchestrator needs to act on it. */
export function noticeText(id: string, what: string, s: Pick<RunState, "role" | "branch" | "step" | "tool">, dirty: number | null): string {
  const facts = [`role ${s.role}`];
  if (s.branch) facts.push(`branch ${s.branch}`);
  facts.push(`last step: ${s.step || "none"}`);
  if (s.tool && s.tool !== s.step) facts.push(`last tool: ${s.tool}`);
  facts.push(`uncommitted changes: ${dirty ?? "unknown"}`);
  const sep = what.startsWith("'") ? "" : " ";
  const cancelled = what === "cancelled by user";
  const tag = cancelled ? "agent-cancelled" : "agent-exit";
  const policy = cancelled ? "; leave stopped until the user explicitly authorizes continuation" : "";
  return `[${tag}] ${id}${sep}${oneLine(what, 600)} (${facts.join("; ")})${policy}`;
}

/** Close the run and send its notice to the orchestrator from `id`. False when the run was already closed. */
export async function sendNotice(project: string, id: string, run: string, text: () => Promise<string>): Promise<boolean> {
  if (!(await claim(project, id, run))) return false;
  try {
    await put(project, "orchestrator", { from: id, text: await text() });
  } catch (err) {
    // Reopen the run so another sender can try.
    await unlink(claimFile(project, id, run)).catch(() => {});
    throw err;
  }
  return true;
}

/** What the agent loop reports as it goes; createAgent calls these. */
export interface Tracker {
  /** About to ask the model. */
  model(): Promise<void>;
  /** About to run a tool: the agent is working, so any earlier report no longer counts. */
  tool(name: string, input: unknown): Promise<void>;
  /** The tool just run was a successful message to the orchestrator. */
  reported(): Promise<void>;
  /** New messages arrived in its inbox: it needs to report again. */
  instructed(): Promise<void>;
}

export const describeTool = (name: string, input: unknown) => oneLine(`${name} ${JSON.stringify(input) ?? ""}`, 160);

export interface RunInfo {
  project: string;
  id: string;
  run: string;
  role: Role;
  branch?: string;
  cwd: string;
}

/** Drop claim files older than a day. Recent ones stay, so an old run's follow-up still sees its own claim after a quick respawn. */
async function pruneClaims(project: string, now = Date.now()): Promise<void> {
  const dir = paths.runs(project);
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (!n.endsWith(".exit")) continue;
    const path = join(dir, n);
    const st = await stat(path).catch(() => null);
    if (st && now - st.mtimeMs > CLAIM_TTL_MS) await unlink(path).catch(() => {});
  }
}

/** Start a run: write a fresh state; the returned tracker keeps it current. */
export async function beginRun(info: RunInfo, pid = process.pid): Promise<Tracker & { state: () => RunState; end: () => Promise<void> }> {
  const { project, id, run } = info;
  await pruneClaims(project);
  const s: RunState = { run, pid, role: info.role, branch: info.branch, state: "running", step: "starting", tool: "", ts: "", startedAt: new Date().toISOString() };
  const save = () => writeRun(project, id, { ...s, ts: new Date().toISOString() });
  const set = async (patch: Partial<RunState>) => {
    Object.assign(s, patch);
    await save();
  };
  await save();
  await startTaskRun(project, run);
  return {
    state: () => ({ ...s }),
    end: async () => { s.endedAt ??= new Date().toISOString(); await save(); },
    model: () => set({ step: "model request" }),
    tool: async (name, input) => {
      if (name === "bash") await invalidateTaskBranch(project, run);
      const step = describeTool(name, input);
      return set({ step, tool: step, state: "running" });
    },
    reported: () => set({ state: "reported" }),
    instructed: async () => { await invalidateTaskBranch(project, run); if (s.state !== "running") await set({ state: "running" }); },
  };
}

/** Signals that stop an agent window: tmux kill-window (HUP), kill (TERM), Ctrl-C (INT). */
const SIGNALS = [["SIGHUP", 1], ["SIGTERM", 15], ["SIGINT", 2]] as const;
export type SignalSource = (handler: (name: string, n: number) => void) => () => void;

const processSignals: SignalSource = (handler) => {
  const offs = SIGNALS.map(([name, n]) => {
    const f = () => handler(name, n);
    process.on(name, f);
    return () => { process.off(name, f); };
  });
  return () => { for (const off of offs) off(); };
};

export interface SuperviseOptions {
  log?: (s: string) => void;
  /** Where SIGHUP/SIGTERM/SIGINT come from; tests inject a fake. */
  signals?: SignalSource;
  /** How a signal ends the process; tests replace it. */
  exit?: (code: number) => void;
}

/** What closing a run needs from its tracker. */
type Closable = { state: () => RunState; end: () => Promise<void> };

/** The run's state with its end time stamped first, so the git wait for the notice does not count as run time. */
async function stamped(t: Closable, log: (s: string) => void): Promise<RunState> {
  try { await t.end(); } catch (err) { log(`agent: could not record the end time: ${String(err)}`); }
  return t.state();
}

/**
 * Close a finished run: no notice when its last act was a report, else
 * `what` with the facts from the in-memory state. Returns whether a notice went out.
 */
async function closeRun(info: RunInfo, t: Closable, what: string, gitMs: number, log: (s: string) => void): Promise<boolean> {
  const s = await stamped(t, log);
  try {
    const kind = what === "cancelled by user" ? "cancelled" : what.startsWith("crashed") ? "blocked" : s.state === "reported" && what === "finished without reporting" ? "waiting" : "unknown";
    await stopTaskRun(info.project, info.run, kind, kind === "waiting" ? "agent reported; awaiting next explicit task step" : oneLine(what));
  } catch (err) { log(`agent: could not update task: ${String(err)}`); }
  if (s.state === "reported" && what !== "cancelled by user") {
    await claim(info.project, info.id, info.run);
    return false;
  }
  try {
    return await sendNotice(info.project, info.id, info.run, async () => noticeText(info.id, what, s, await dirtyCount(info.cwd, gitMs)));
  } catch (err) {
    log(`agent: could not send exit notice: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Close the run from in-memory state on SIGHUP/SIGTERM/SIGINT ("killed by
 * SIG…", a short git timeout), then exit 128+n. `stopping()` tells whether
 * one arrived; `off()` removes the handlers.
 */
function handleSignals(info: RunInfo, t: Closable, opts: SuperviseOptions, log: (s: string) => void) {
  let stopping = false;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const off = (opts.signals ?? processSignals)((name, n) => {
    if (stopping) return;
    stopping = true;
    void closeRun(info, t, `killed by ${name}`, SIGNAL_GIT_TIMEOUT_MS, log).finally(() => exit(128 + n));
  });
  return { off, stopping: () => stopping };
}

/** A body's return value when its project is gone: the run is left as it is, nothing is written back. */
export const ABANDONED: unique symbol = Symbol("abandoned");

/**
 * Run an agent and close its run when it stops:
 * - throws: "crashed: <error>", exit SETTLED_EXIT (1 if the run could not be closed)
 * - ends without a final report: "finished without reporting", exit 0
 * - returns ABANDONED (the project was deleted underneath): exit 0, the run is not closed
 * - SIGHUP/SIGTERM/SIGINT: "killed by SIG…", exit 128+n
 * Returns the exit code.
 */
export async function supervise(info: RunInfo, body: (t: Tracker) => Promise<void | typeof ABANDONED>, opts: SuperviseOptions = {}): Promise<number> {
  const log = opts.log ?? ((s: string) => console.error(s));
  const t = await beginRun(info);
  const signals = handleSignals(info, t, opts, log);
  let what = "finished without reporting";
  let code = 0;
  let abandoned = false;
  try {
    abandoned = await body(t) === ABANDONED;
  } catch (err) {
    if (err instanceof Cancelled) what = "cancelled by user";
    else {
      const msg = err instanceof Error ? err.message : String(err);
      log(`agent crashed: ${err instanceof Error && err.stack ? err.stack : msg}`);
      what = `crashed: ${msg}`;
      code = 1;
    }
  } finally {
    signals.off();
  }
  // A signal handler is closing the run and will exit the process.
  if (signals.stopping()) return code;
  if (abandoned) return code; // nothing to close: the project's files are gone and must not come back
  await closeRun(info, t, what, GIT_TIMEOUT_MS, log);
  return code && claimed(info.project, info.id, info.run) ? SETTLED_EXIT : code;
}

/** True while `pid` is a running process (EPERM still means it exists). */
export { pidAlive };

export interface WatchdogOptions {
  /** Live agent windows, or null when tmux could not be asked (then the check is skipped). */
  live: (project: string) => Promise<string[] | null>;
  alive?: (pid: number) => boolean;
  dirty?: (cwd: string) => Promise<number | null>;
}

/** Agent ids with a run state on disk. */
async function runIds(project: string): Promise<string[]> {
  const names = await readdir(paths.runs(project)).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
}

type Probe = Required<Omit<WatchdogOptions, "live">>;

/** The open, silent, dead run for `id`; "alive" while its process still runs; null when there is nothing to send. */
async function staleRun(project: string, id: string, probe: Probe): Promise<RunState | "alive" | null> {
  const s = await readRun(project, id);
  if (!s || s.state === "reported" || claimed(project, id, s.run)) return null;
  return probe.alive(s.pid) ? "alive" : s;
}

/** Send `what` for one agent not in `live`; "alive" means check it again next time. */
async function checkAgent(project: string, id: string, what: string, probe: Probe): Promise<"sent" | "alive" | null> {
  const s = await staleRun(project, id, probe);
  if (s === "alive" || s === null) return s;
  const cwd = s.branch ? paths.worktree(project, slug(s.branch)) : null;
  const sent = await sendNotice(project, id, s.run, async () => noticeText(id, what, s, cwd ? await probe.dirty(cwd) : null));
  return sent ? "sent" : null;
}

/**
 * Check the agents not in `live`: those seen live last time (`before`), or
 * on the first check every run on disk. Returns who was notified and who to
 * watch next time.
 */
async function sweep(project: string, live: Set<string>, before: Set<string> | undefined, probe: Probe): Promise<{ sent: string[]; keep: Set<string> }> {
  const keep = new Set(live);
  const sent: string[] = [];
  const what = before ? "'s window is gone" : "stopped while the tui was not watching";
  for (const id of before ?? (await runIds(project))) {
    if (live.has(id)) continue;
    const r = await checkAgent(project, id, what, probe);
    if (r === "alive") keep.add(id);
    if (r === "sent") sent.push(id);
  }
  return { sent, keep };
}

/**
 * The exit watchdog, run by the orchestrator daemon's poll. Each check lists a project's live agent windows.
 * The first check per project sweeps every run on disk ("stopped while the
 * TUI was not watching"); later ones look at agents seen live before whose
 * window is gone ("'s window is gone"). Either way a notice goes out only
 * when the run is open (no claim), its last act was not a report, its
 * window is not live, and its pid is dead; an agent whose window is gone
 * but whose process lives is checked again next time. Returns the ids
 * notified. One check per project at a time; a failed tmux query skips it.
 */
export function watchdog(opts: WatchdogOptions) {
  const probe: Probe = { alive: opts.alive ?? pidAlive, dirty: opts.dirty ?? ((cwd) => dirtyCount(cwd)) };
  const seen = new Map<string, Set<string>>();
  const busy = new Set<string>();
  return async function check(project: string): Promise<string[]> {
    if (busy.has(project)) return [];
    busy.add(project);
    try {
      const now = await opts.live(project);
      if (now === null) return [];
      let recovered: string[] = [];
      try { recovered = await recoverTaskRuns(project, new Set(now), probe.alive, Date.now(), probe.dirty); }
      catch (err) { console.error(`watchdog: could not recover tasks: ${String(err)}`); }
      const { sent, keep } = await sweep(project, new Set(now), seen.get(project), probe);
      seen.set(project, keep);
      return [...recovered, ...sent];
    } finally {
      busy.delete(project);
    }
  };
}

/**
 * Restart recovery never guesses completion. A missing/stopped process leaves a visible reason.
 * Prepared launches get a grace period so a second TUI cannot race normal startup.
 * A run that never wrote its run record (the process died before beginRun after the
 * launch check had passed, or never ran at all) has no other sender, so one notice
 * goes to the orchestrator here (notifyNeverStarted), closed by the run's claim like
 * every other notice. Returns the agents notified.
 */
export async function recoverTaskRuns(project: string, live: Set<string>, alive = pidAlive, now = Date.now(), dirty: (cwd: string) => Promise<number | null> = (cwd) => dirtyCount(cwd)): Promise<string[]> {
  const sent: string[] = [];
  for (const task of await allTasks(project)) {
    const r = lostRun(task, live, now);
    if (!r) continue;
    const state = await readRun(project, r.agent);
    if (state?.run === r.id && alive(state.pid)) continue;
    await stopTaskRun(project, r.id, "unknown", "agent is no longer observable; task needs explicit reconciliation");
    if (state?.run === r.id) continue; // its record is there: the sweep (or its own exit path) reports it
    if (await notifyNeverStarted(project, task, r, dirty)) sent.push(r.agent);
  }
  return sent;
}

/** An active task's latest run that should be running but has no live window and is past the launch grace. */
function lostRun(task: Task, live: Set<string>, now: number): TaskRun | undefined {
  const r = task.runs.at(-1);
  if (task.archive || !r || !["prepared", "started"].includes(r.state) || live.has(r.agent)) return undefined;
  if (r.state === "prepared" && now - Date.parse(r.preparedAt) < 30_000) return undefined;
  return r;
}

/** One notice for a task run without a run record; false when it was already closed or the send failed. */
async function notifyNeverStarted(project: string, task: Task, r: TaskRun, dirty: (cwd: string) => Promise<number | null>): Promise<boolean> {
  const what = `${r.state === "prepared" ? "never started" : "stopped before it was observable"}; task "${task.name}" needs reconciliation`;
  const facts = { role: r.role, branch: task.branch, step: "before the agent started", tool: "" };
  try {
    return await sendNotice(project, r.agent, r.id, async () => noticeText(r.agent, what, facts, await dirty(paths.worktree(project, slug(task.branch)))));
  } catch (err) {
    console.error(`watchdog: could not send the never-started notice for ${r.agent}: ${String(err)}`);
    return false;
  }
}
