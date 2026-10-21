// Exit notices: when a worker or reviewer stops without reporting, the
// orchestrator hears about it through its inbox, exactly once per run.
//
// Each run of an agent (one `parallels agent` process) has a run id, chosen by
// agentCommand and passed to both the agent and the shell follow-up after it.
// The agent keeps runs/<id>.json up to date: the run id, whether it has
// reported since its last instruction, its last step and tool. Every path
// that sends a notice first claims runs/<id>.<run>.exit with an exclusive
// create, so the four senders (crash, clean exit, shell follow-up, TUI
// watchdog) never duplicate one another.

import { mkdirSync } from "node:fs";
import { open as openFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { paths } from "./config";
import { put } from "./inbox";
import type { Role } from "./transcript";

export interface RunState {
  run: string;
  role: Role;
  branch?: string;
  /** "reported" once the agent messages the orchestrator; back to "running" when new instructions arrive. */
  state: "running" | "reported";
  /** What it was doing last: a model request or a tool call. */
  step: string;
  /** The last tool call, kept when the step moves on to the next model request. */
  tool: string;
  /** `git status --porcelain` line count after the last tool call; null when unknown. */
  dirty: number | null;
  ts: string;
}

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

/** Take the right to send this run's one exit notice. False if someone already has. */
export async function claim(project: string, id: string, run: string): Promise<boolean> {
  mkdirSync(paths.runs(project), { recursive: true });
  try {
    await (await openFile(claimFile(project, id, run), "wx")).close();
    return true;
  } catch {
    return false;
  }
}

/** Uncommitted changes in `cwd` (`git status --porcelain` lines), or null outside a repo. */
export async function dirtyCount(cwd: string): Promise<number | null> {
  try {
    const res = await $`git status --porcelain`.cwd(cwd).quiet().nothrow();
    if (res.exitCode !== 0) return null;
    return res.stdout.toString().split("\n").filter(Boolean).length;
  } catch {
    return null;
  }
}

/** One line, capped, for a notice. */
const oneLine = (s: string, max = 400) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** The notice text: what happened plus what the orchestrator needs to act on it. */
export function noticeText(id: string, what: string, s: Pick<RunState, "role" | "branch" | "step" | "tool"> | null, dirty: number | null): string {
  const facts = [
    s ? `role ${s.role}` : null,
    s?.branch ? `branch ${s.branch}` : null,
    `last step: ${s?.step || "none"}`,
    s?.tool && s.tool !== s.step ? `last tool: ${s.tool}` : null,
    `uncommitted changes: ${dirty === null ? "unknown" : dirty}`,
  ].filter(Boolean);
  const sep = what.startsWith("'") ? "" : " ";
  return `[agent-exit] ${id}${sep}${oneLine(what, 600)} (${facts.join("; ")})`;
}

/** Claim the run's notice and send it to the orchestrator from `id`. False when one was already sent. */
export async function sendNotice(project: string, id: string, run: string, text: string): Promise<boolean> {
  if (!(await claim(project, id, run))) return false;
  await put(project, "orchestrator", { from: id, text });
  return true;
}

/** What the agent loop reports as it goes; createAgent calls these. */
export interface Tracker {
  /** About to ask the model, or about to run a tool. */
  step(step: string, tool?: boolean): Promise<void>;
  /** A tool call finished. */
  toolDone(): Promise<void>;
  /** The agent sent a message to the orchestrator. */
  reported(): Promise<void>;
  /** New messages arrived in its inbox: a report from now on is a new one. */
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

/** Start a run: clears the previous run's claim and writes a fresh state. */
export async function beginRun(info: RunInfo): Promise<Tracker & { state: () => RunState }> {
  const { project, id, run, cwd } = info;
  const dir = paths.runs(project);
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (n.startsWith(`${id}.`) && n.endsWith(".exit")) await unlink(join(dir, n)).catch(() => {});
  }
  const s: RunState = { run, role: info.role, branch: info.branch, state: "running", step: "starting", tool: "", dirty: null, ts: new Date().toISOString() };
  const save = () => writeRun(project, id, { ...s, ts: new Date().toISOString() });
  await save();
  return {
    state: () => ({ ...s }),
    async step(step, tool = false) {
      s.step = step;
      if (tool) s.tool = step;
      await save();
    },
    async toolDone() {
      s.dirty = await dirtyCount(cwd);
      await save();
    },
    async reported() {
      if (s.state === "reported") return;
      s.state = "reported";
      await save();
    },
    async instructed() {
      if (s.state === "running") return;
      s.state = "running";
      await save();
    },
  };
}

/**
 * Run an agent and send the right notice when it stops: "crashed" when it
 * throws (exit code 1), "finished without reporting" when it ends cleanly
 * without having reported since its last instruction. Returns the exit code.
 */
export async function supervise(info: RunInfo, body: (t: Tracker) => Promise<void>, log: (s: string) => void = (s) => console.error(s)): Promise<number> {
  const t = await beginRun(info);
  let code = 0;
  let what: string | null = null;
  try {
    await body(t);
  } catch (err) {
    code = 1;
    const msg = err instanceof Error ? err.message : String(err);
    log(`agent crashed: ${err instanceof Error && err.stack ? err.stack : msg}`);
    what = `crashed: ${msg}`;
  }
  const s = t.state();
  if (what === null && s.state === "reported") return code;
  what ??= "finished without reporting";
  const text = noticeText(info.id, what, s, await dirtyCount(info.cwd));
  try {
    await sendNotice(info.project, info.id, info.run, text);
  } catch (err) {
    log(`agent: could not send exit notice: ${err instanceof Error ? err.message : String(err)}`);
  }
  return code;
}

/**
 * The shell follow-up after a non-zero exit (`parallels agent-exit`): a signal,
 * OOM or an uncaught error the agent could not report itself. Sends nothing if
 * this run already reported or a notice went out.
 */
export async function afterExit(info: RunInfo & { code: number }): Promise<boolean> {
  const s = await readRun(info.project, info.id);
  const mine = s?.run === info.run ? s : null;
  if (mine?.state === "reported") return false;
  const why = info.code > 128 ? `exited (code ${info.code}, signal ${info.code - 128})` : `exited (code ${info.code})`;
  const fallback = { role: info.role, branch: info.branch, step: mine ? "" : "before the agent started", tool: "" };
  const text = noticeText(info.id, `${why} without reporting`, mine ?? fallback, await dirtyCount(info.cwd));
  return sendNotice(info.project, info.id, info.run, text);
}

/**
 * The TUI's watchdog. Each check lists a project's live agent windows; an
 * agent seen live on an earlier check whose window is now gone, and whose
 * run neither reported nor sent a notice, gets "window is gone". Returns
 * the ids it sent notices for. One check per project at a time.
 */
export function watchdog(live: (project: string) => Promise<string[]>) {
  const seen = new Map<string, Set<string>>();
  const busy = new Set<string>();
  return async function check(project: string): Promise<string[]> {
    if (busy.has(project)) return [];
    busy.add(project);
    try {
      const now = new Set(await live(project));
      const before = seen.get(project) ?? new Set<string>();
      seen.set(project, now);
      const sent: string[] = [];
      for (const id of before) {
        if (now.has(id)) continue;
        const s = await readRun(project, id);
        if (!s || s.state === "reported") continue;
        const text = noticeText(id, "'s window is gone", s, s.dirty);
        if (await sendNotice(project, id, s.run, text)) sent.push(id);
      }
      return sent;
    } finally {
      busy.delete(project);
    }
  };
}
