// Long-running commands kept in $ORCA_DATA/processes/ (conversation scope): <id>.json the record, <id>.log the
// output, <id>.exit the exit code a wrapper shell writes when the command ends. Nothing here holds the process: it
// runs detached in its own process group and outlives the agent that started it; the state is read back from disk.
// A timeout is enforced by whoever looks next (the tool, the tab, the daemon's watcher every 2s).
import { mkdir, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../../core/conversations";

export type ProcState = "running" | "exited" | "killed" | "timed-out";
export type Proc = {
  id: string;
  owner: string;
  command: string;
  cwd: string;
  pid: number;
  state: ProcState;
  code: number | null;
  timeoutMs: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Whether the owner knows it ended (told by the watcher, or saw it through wait/output/stop). */
  notified: boolean;
};

export const OUTPUT_BYTES = 16 * 1024;
const ID = /^[a-z0-9]{8}$/;
// The wrapper: the command's output to the log, then its exit code to <id>.exit (written whole, then renamed).
const WRAPPER = 'bash -c "$1" >"$2" 2>&1 </dev/null; code=$?; printf %s "$code" >"$3.tmp"; mv "$3.tmp" "$3"';

const file = (dir: string, id: string, ext: string): string => join(dir, `${id}.${ext}`);
export const logFile = (dir: string, id: string): string => file(dir, id, "log");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}

async function save(dir: string, proc: Proc): Promise<void> {
  await writeAtomic(file(dir, proc.id, "json"), JSON.stringify(proc, null, 2));
}

async function load(dir: string, id: string): Promise<Proc | null> {
  if (!ID.test(id)) return null;
  const f = Bun.file(file(dir, id, "json"));
  return await f.exists() ? await f.json() as Proc : null;
}

/** Bring a running record up to date: its exit code, a vanished process, or a passed timeout. */
async function refresh(dir: string, proc: Proc, now: number): Promise<Proc> {
  if (proc.state !== "running") return proc;
  const exit = Bun.file(file(dir, proc.id, "exit"));
  if (await exit.exists()) {
    const code = Number.parseInt(await exit.text(), 10);
    const ended = { ...proc, state: "exited" as const, code: Number.isNaN(code) ? null : code, endedAt: new Date(now).toISOString() };
    await save(dir, ended);
    return ended;
  }
  if (!alive(proc.pid)) {
    const ended = { ...proc, state: "exited" as const, endedAt: new Date(now).toISOString() };
    await save(dir, ended);
    return ended;
  }
  if (proc.timeoutMs !== null && now - Date.parse(proc.startedAt) > proc.timeoutMs) return await kill(dir, proc, "timed-out");
  return proc;
}

async function kill(dir: string, proc: Proc, state: "killed" | "timed-out"): Promise<Proc> {
  signalGroup(proc.pid, "SIGTERM");
  for (let i = 0; i < 20 && alive(proc.pid); i++) await Bun.sleep(100);
  if (alive(proc.pid)) signalGroup(proc.pid, "SIGKILL");
  const ended = { ...proc, state, endedAt: new Date().toISOString() };
  await save(dir, ended);
  return ended;
}

export async function getProc(dir: string, id: string): Promise<Proc | null> {
  const proc = await load(dir, id);
  return proc === null ? null : await refresh(dir, proc, Date.now());
}

/** Every process of the conversation, oldest first, up to date. */
export async function listProcs(dir: string): Promise<Proc[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const procs: Proc[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const proc = await getProc(dir, name.slice(0, -5));
    if (proc !== null) procs.push(proc);
  }
  return procs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function startProc(dir: string, spec: { owner: string; command: string; cwd: string; env: Record<string, string>; timeoutMs: number | null }): Promise<Proc> {
  await mkdir(dir, { recursive: true });
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const child = Bun.spawn(["bash", "-c", WRAPPER, "wrapper", spec.command, logFile(dir, id), file(dir, id, "exit")],
    { cwd: spec.cwd, env: spec.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  child.unref();
  const proc: Proc = { id, owner: spec.owner, command: spec.command, cwd: spec.cwd, pid: child.pid, state: "running", code: null,
    timeoutMs: spec.timeoutMs, startedAt: new Date().toISOString(), endedAt: null, notified: false };
  await save(dir, proc);
  return proc;
}

export async function stopProc(dir: string, proc: Proc): Promise<Proc> {
  const ended = proc.state === "running" ? await kill(dir, proc, "killed") : proc;
  return await markNotified(dir, ended);
}

export async function markNotified(dir: string, proc: Proc): Promise<Proc> {
  if (proc.notified || proc.state === "running") return proc;
  const told = { ...proc, notified: true };
  await save(dir, told);
  return told;
}

/** Output from a byte cursor, at most OUTPUT_BYTES, cut at a line end when there is more; and the next cursor. */
export async function readOutput(dir: string, id: string, cursor: number): Promise<{ text: string; next: number; more: boolean }> {
  const path = logFile(dir, id);
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  const from = Math.max(0, Math.min(cursor, size));
  const length = Math.min(OUTPUT_BYTES, size - from);
  if (length === 0) return { text: "", next: from, more: false };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, from);
    const more = from + length < size;
    const cut = more && buffer.lastIndexOf(10) > 0 ? buffer.lastIndexOf(10) + 1 : length;
    return { text: buffer.subarray(0, cut).toString("utf8"), next: from + cut, more };
  } finally { await handle.close(); }
}

/** The last `lines` lines of a process's output. */
export async function tail(dir: string, id: string, lines: number): Promise<string[]> {
  const path = logFile(dir, id);
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  const from = Math.max(0, size - OUTPUT_BYTES);
  const { text } = await readOutput(dir, id, from);
  const all = text.replace(/\n$/, "").split("\n");
  return text.length === 0 ? [] : all.slice(-lines);
}

export function describe(proc: Proc): string {
  const runtime = Math.round(((proc.endedAt === null ? Date.now() : Date.parse(proc.endedAt)) - Date.parse(proc.startedAt)) / 1000);
  const end = proc.state === "exited" ? `exit ${proc.code ?? "unknown"}` : proc.state;
  return `${proc.id} ${end} ${runtime}s: ${proc.command}`;
}
