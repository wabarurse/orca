import { mkdir, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fail, ok, parseJson, type Result } from "../../config";
import { writeAtomic, type Links } from "../../core/plugins";

const ProcStateSchema = z.enum(["running", "exited", "killed", "timed-out"]);
const ProcSchema = z.object({
  id: z.string(),
  owner: z.string(),
  command: z.string(),
  cwd: z.string(),
  pid: z.number().int().nullable(),
  runner: z.string().default("plain"),
  state: ProcStateSchema,
  code: z.number().int().nullable(),
  timeoutMs: z.number().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  notified: z.boolean(),
});

export type ProcState = z.infer<typeof ProcStateSchema>;
export type Proc = z.infer<typeof ProcSchema>;

export const OUTPUT_BYTES = 16 * 1024;
const ID = /^[a-z0-9]{8}$/;
const WRAPPER = 'bash -c "$1" >"$2" 2>&1 </dev/null; code=$?; printf %s "$code" >"$3.tmp"; mv "$3.tmp" "$3"';
const SHOWN = 'bash -c "$1" 2>&1 | tee "$2"; code=${PIPESTATUS[0]}; printf %s "$code" >"$3.tmp"; mv "$3.tmp" "$3"; printf "\\n[exit %s]\\n" "$code"';

export type ProcControl = { conversation: string; links: Links };
export const procLabel = (id: string): string => `proc-${id}`;

const file = (dir: string, id: string, ext: string): string => join(dir, `${id}.${ext}`);
export const logFile = (dir: string, id: string): string => file(dir, id, "log");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { return; } }
}

async function save(dir: string, proc: Proc): Promise<void> {
  await writeAtomic(file(dir, proc.id, "json"), JSON.stringify(proc, null, 2));
}

async function load(dir: string, id: string): Promise<Result<Proc | null>> {
  if (!ID.test(id)) return ok(null);
  const f = Bun.file(file(dir, id, "json"));
  if (!await f.exists()) return ok(null);
  const json = parseJson(await f.text());
  const parsed = json.ok ? ProcSchema.safeParse(json.data) : null;
  return parsed !== null && parsed.success ? ok(parsed.data) : fail(`invalid process record ${id}.json`);
}

async function windowGone(proc: Proc, ctl: ProcControl | null): Promise<boolean> {
  if (proc.pid !== null || ctl === null) return false;
  const runner = await ctl.links.runnerNamed(proc.runner);
  const alive = runner === null ? null : await runner.alive(ctl.conversation);
  return alive !== null && !alive.includes(procLabel(proc.id));
}

async function refresh(dir: string, proc: Proc, now: number, ctl: ProcControl | null): Promise<Proc> {
  if (proc.state !== "running") return proc;
  const exit = Bun.file(file(dir, proc.id, "exit"));
  if (await exit.exists()) {
    const code = Number.parseInt(await exit.text(), 10);
    const ended: Proc = { ...proc, state: "exited", code: Number.isNaN(code) ? null : code, endedAt: new Date(now).toISOString() };
    await save(dir, ended);
    return ended;
  }
  if (proc.pid === null ? await windowGone(proc, ctl) : !alive(proc.pid)) {
    const ended: Proc = { ...proc, state: "exited", endedAt: new Date(now).toISOString() };
    await save(dir, ended);
    return ended;
  }
  if (proc.timeoutMs !== null && now - Date.parse(proc.startedAt) > proc.timeoutMs) return await kill(dir, proc, "timed-out", ctl);
  return proc;
}

async function kill(dir: string, proc: Proc, state: "killed" | "timed-out", ctl: ProcControl | null): Promise<Proc> {
  const pid = proc.pid;
  if (pid === null) {
    const runner = ctl === null ? null : await ctl.links.runnerNamed(proc.runner);
    if (runner === null || ctl === null) return proc;
    await runner.stop(ctl.conversation, procLabel(proc.id));
  } else {
    signalGroup(pid, "SIGTERM");
    for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(100);
    if (alive(pid)) signalGroup(pid, "SIGKILL");
  }
  const ended: Proc = { ...proc, state, endedAt: new Date().toISOString() };
  await save(dir, ended);
  return ended;
}

export async function getProc(dir: string, id: string, ctl: ProcControl | null): Promise<Result<Proc | null>> {
  const proc = await load(dir, id);
  if (!proc.ok || proc.data === null) return proc;
  return ok(await refresh(dir, proc.data, Date.now(), ctl));
}

export async function listProcs(dir: string, ctl: ProcControl | null): Promise<Result<Proc[]>> {
  const names = await readdir(dir).catch((): string[] => []);
  const procs: Proc[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const proc = await getProc(dir, name.slice(0, -5), ctl);
    if (!proc.ok) return proc;
    if (proc.data !== null) procs.push(proc.data);
  }
  return ok(procs.sort((a, b) => a.startedAt.localeCompare(b.startedAt)));
}

export async function startProc(dir: string, spec: { owner: string; command: string; cwd: string; env: Record<string, string>; timeoutMs: number | null }, ctl: ProcControl | null): Promise<Proc> {
  await mkdir(dir, { recursive: true });
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const runner = ctl === null ? null : await ctl.links.runner();
  let pid: number | null = null;
  if (runner === null || ctl === null || runner.name === "plain") {
    const child = Bun.spawn(["bash", "-c", WRAPPER, "wrapper", spec.command, logFile(dir, id), file(dir, id, "exit")],
      { cwd: spec.cwd, env: spec.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    child.unref();
    pid = child.pid;
  } else {
    await runner.start({ conversation: ctl.conversation, agent: procLabel(id), argv: ["bash", "-c", SHOWN, "shown", spec.command, logFile(dir, id), file(dir, id, "exit")],
      cwd: spec.cwd, env: spec.env, log: file(dir, id, "window.log") });
  }
  const proc: Proc = { id, owner: spec.owner, command: spec.command, cwd: spec.cwd, pid, runner: pid === null && runner !== null ? runner.name : "plain", state: "running", code: null,
    timeoutMs: spec.timeoutMs, startedAt: new Date().toISOString(), endedAt: null, notified: false };
  await save(dir, proc);
  return proc;
}

export async function stopProc(dir: string, proc: Proc, ctl: ProcControl | null): Promise<Proc> {
  const ended = proc.state === "running" ? await kill(dir, proc, "killed", ctl) : proc;
  return await markNotified(dir, ended);
}

export async function markNotified(dir: string, proc: Proc): Promise<Proc> {
  if (proc.notified || proc.state === "running") return proc;
  const told: Proc = { ...proc, notified: true };
  await save(dir, told);
  return told;
}

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
