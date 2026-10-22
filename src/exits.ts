import { Cancelled } from "./cancellation";
// Exit notices: when a worker or reviewer stops without reporting, the
// orchestrator hears about it through its inbox, at most once per run.
//
// Each run of an agent (one `parallels agent` process) has a run id, chosen by
// agentCommand and passed to both the agent and the shell follow-up after it.
// The agent keeps runs/<id>.json up to date: run id, pid, whether its last
// act was a report, its last step and tool. A run is closed by creating
// runs/<id>.<run>.exit exclusively: whoever creates it sends the notice, or
// none when the run ended on a report. So the senders (crash, signal, clean
// exit, shell follow-up, TUI watchdog and startup sweep) never duplicate.

import { existsSync, mkdirSync } from "node:fs";
import { open as openFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";
import { put } from "./inbox";
import { run } from "./proc";
import { SETTLED_EXIT, slug } from "./runner";
import type { Role } from "./transcript";

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
  ts: string;
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
export async function beginRun(info: RunInfo, pid = process.pid): Promise<Tracker & { state: () => RunState }> {
  const { project, id, run } = info;
  await pruneClaims(project);
  const s: RunState = { run, pid, role: info.role, branch: info.branch, state: "running", step: "starting", tool: "", ts: "" };
  const save = () => writeRun(project, id, { ...s, ts: new Date().toISOString() });
  const set = async (patch: Partial<RunState>) => {
    Object.assign(s, patch);
    await save();
  };
  await save();
  return {
    state: () => ({ ...s }),
    model: () => set({ step: "model request" }),
    tool: (name, input) => {
      const step = describeTool(name, input);
      return set({ step, tool: step, state: "running" });
    },
    reported: () => set({ state: "reported" }),
    instructed: () => (s.state === "running" ? Promise.resolve() : set({ state: "running" })),
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

/**
 * Close a finished run: no notice when its last act was a report, else
 * `what` with the facts from the in-memory state. Returns whether a notice went out.
 */
async function closeRun(info: RunInfo, s: RunState, what: string, gitMs: number, log: (s: string) => void): Promise<boolean> {
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
function handleSignals(info: RunInfo, t: { state: () => RunState }, opts: SuperviseOptions, log: (s: string) => void) {
  let stopping = false;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const off = (opts.signals ?? processSignals)((name, n) => {
    if (stopping) return;
    stopping = true;
    void closeRun(info, t.state(), `killed by ${name}`, SIGNAL_GIT_TIMEOUT_MS, log).finally(() => exit(128 + n));
  });
  return { off, stopping: () => stopping };
}

/**
 * Run an agent and close its run when it stops:
 * - throws: "crashed: <error>", exit SETTLED_EXIT (1 if the run could not be closed)
 * - ends without a final report: "finished without reporting", exit 0
 * - SIGHUP/SIGTERM/SIGINT: "killed by SIG…", exit 128+n
 * Returns the exit code.
 */
export async function supervise(info: RunInfo, body: (t: Tracker) => Promise<void>, opts: SuperviseOptions = {}): Promise<number> {
  const log = opts.log ?? ((s: string) => console.error(s));
  const t = await beginRun(info);
  const signals = handleSignals(info, t, opts, log);
  let what = "finished without reporting";
  let code = 0;
  try {
    await body(t);
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
  await closeRun(info, t.state(), what, GIT_TIMEOUT_MS, log);
  return code && claimed(info.project, info.id, info.run) ? SETTLED_EXIT : code;
}

/**
 * The shell follow-up after a non-zero exit (`parallels agent-exit`): a signal,
 * OOM or an uncaught error the agent could not report itself. Sends nothing if
 * the run is already closed or its last act was a report.
 */
export async function afterExit(info: RunInfo & { code: number }): Promise<boolean> {
  const s = await readRun(info.project, info.id);
  const mine = s?.run === info.run ? s : null;
  if (mine?.state === "reported") {
    await claim(info.project, info.id, info.run);
    return false;
  }
  const why = info.code > 128 ? `exited (code ${info.code}, signal ${info.code - 128})` : `exited (code ${info.code})`;
  const facts = mine ?? { role: info.role, branch: info.branch, step: "before the agent started", tool: "" };
  return sendNotice(info.project, info.id, info.run, async () => noticeText(info.id, `${why} without reporting`, facts, await dirtyCount(info.cwd)));
}

/** True while `pid` is a running process (EPERM still means it exists). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
  const what = before ? "'s window is gone" : "stopped while the TUI was not watching";
  for (const id of before ?? (await runIds(project))) {
    if (live.has(id)) continue;
    const r = await checkAgent(project, id, what, probe);
    if (r === "alive") keep.add(id);
    if (r === "sent") sent.push(id);
  }
  return { sent, keep };
}

/**
 * The TUI's watchdog. Each check lists a project's live agent windows.
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
      const { sent, keep } = await sweep(project, new Set(now), seen.get(project), probe);
      seen.set(project, keep);
      return sent;
    } finally {
      busy.delete(project);
    }
  };
}
