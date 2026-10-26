// The file channel between TUIs (clients) and a project's orchestrator daemon
// (src/orchestrator-daemon.ts). Clients only enqueue and read: input goes
// through the inbox, cancellation through the launch's `.cancel` request
// (src/cancellation.ts), everything else through a request file here. The
// daemon answers each request and each cancel token with an ack file, and
// publishes its state in status.json, so a client can show what the daemon is
// doing without sharing its memory. Liveness is the daemon lock's owner pid.

import { mkdirSync, readFileSync } from "node:fs";
import { readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config";
import type { ContextWindow } from "./model-context";
import { lockOwner, pidAlive } from "./storage-lock";
import { delay } from "./cancellation";

export type DaemonState = "idle" | "turn" | "stopped";
export interface DaemonStatus {
  pid: number;
  run: string;
  state: DaemonState;
  /** When `state` began (ISO). */
  since: string;
  /** Turns started by this daemon, so a client can tell a turn began and ended between two reads. */
  turns: number;
  /** The last turn's context estimate for the header; absent until a turn ran. */
  context?: { model: string; used?: number; window: ContextWindow };
  /** The last turn's failure, until the next turn. */
  error?: string;
}
export type Command = { kind: "clear" } | { kind: "compact" } | { kind: "model"; model: string } | { kind: "stop" };
export interface Request { id: string; ts: string; command: Command }
export interface Ack { id: string; ok: boolean; message: string; at: string }

/** How long a client waits for the daemon to answer before giving up on a request (the daemon may still run it). */
export const ACK_TIMEOUT_MS = 15_000;
const ACK_POLL_MS = 100;
/** Acks nobody collected are dropped on the daemon's next start after this long. */
const ACK_TTL_MS = 60 * 60 * 1000;

const statusFile = (project: string) => join(paths.orchestrator(project), "status.json");
const commandsDir = (project: string) => join(paths.orchestrator(project), "commands");
const acksDir = (project: string) => join(paths.orchestrator(project), "acks");
const ackFile = (project: string, id: string) => join(acksDir(project), `${id}.json`);

/** Publish a whole file by rename, never a partial read for a client. */
async function publish(path: string, content: string): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try { await Bun.write(tmp, content); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}

export function readStatus(project: string): DaemonStatus | undefined {
  try {
    const status = JSON.parse(readFileSync(statusFile(project), "utf8")) as DaemonStatus;
    return typeof status?.pid === "number" && typeof status.run === "string" && typeof status.state === "string" ? status : undefined;
  } catch { return; }
}
export const writeStatus = (project: string, status: DaemonStatus): Promise<void> => publish(statusFile(project), JSON.stringify(status) + "\n");

/** The daemon's process id while one holds the project's daemon lock and that process exists. */
export async function daemonPid(project: string): Promise<number | undefined> {
  const owner = await lockOwner(paths.daemonLock(project));
  return owner && pidAlive(owner.pid) ? owner.pid : undefined;
}
export const daemonAlive = async (project: string): Promise<boolean> => (await daemonPid(project)) !== undefined;

/** The status the live daemon wrote; a file left by a dead one (or another pid) is stale and ignored. */
export async function liveStatus(project: string): Promise<DaemonStatus | undefined> {
  const status = readStatus(project);
  return status && status.pid === await daemonPid(project) ? status : undefined;
}
/** Whether a live daemon is in a turn (compaction and clearing included). */
export const daemonBusy = async (project: string): Promise<boolean> => (await liveStatus(project))?.state === "turn";
/** The live daemon's run id, so a waiting client notices a restart. */
export const liveRun = async (project: string): Promise<string | undefined> => (await liveStatus(project))?.run;

let seq = 0;
/** Enqueue a request; returns its id, which the ack carries. */
export async function request(project: string, command: Command): Promise<string> {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const name = `${ts.replaceAll(":", "-")}-${String(seq++).padStart(6, "0")}-${id.slice(0, 8)}.json`;
  await publish(join(commandsDir(project), name), JSON.stringify({ id, ts, command } satisfies Request) + "\n");
  return id;
}

export interface AckWait { timeoutMs?: number; signal?: AbortSignal; alive?: () => Promise<boolean>; run?: () => Promise<string | undefined> }

/**
 * Wait for the daemon's answer to `id` (a request id or a cancel token) and
 * remove it. Throws when the daemon is dead, when another daemon (a restart)
 * has replaced the one asked (it will never see the request), or after
 * `timeoutMs` (the daemon may still carry it out).
 */
export async function awaitAck(project: string, id: string, opts: AckWait = {}): Promise<Ack> {
  const deadline = Date.now() + (opts.timeoutMs ?? ACK_TIMEOUT_MS);
  const alive = opts.alive ?? (() => daemonAlive(project));
  const run = opts.run ?? (() => liveRun(project));
  const asked = await run();
  for (;;) {
    const ack = await takeAck(project, id);
    if (ack) return ack;
    const gone = await unanswerable(alive, run, asked);
    if (gone) throw new Error(gone);
    if (Date.now() >= deadline) throw new Error("orchestrator did not acknowledge the request in time (it may still carry it out)");
    await delay(ACK_POLL_MS, opts.signal);
  }
}
/** Why no answer will come: the daemon asked is dead, or another run replaced it. */
async function unanswerable(alive: () => Promise<boolean>, run: () => Promise<string | undefined>, asked: string | undefined): Promise<string | undefined> {
  if (!await alive()) return "orchestrator is not running; the request was not acknowledged";
  const now = await run();
  return asked && now && now !== asked ? "orchestrator restarted; the request was not acknowledged" : undefined;
}
async function takeAck(project: string, id: string): Promise<Ack | undefined> {
  const path = ackFile(project, id);
  let ack: Ack;
  try { ack = JSON.parse(readFileSync(path, "utf8")) as Ack; }
  catch { return; }
  await unlink(path).catch(() => {});
  return ack;
}

// --- the daemon's side ---------------------------------------------------------

async function readRequest(path: string): Promise<Request | undefined> {
  try {
    const r = JSON.parse(await Bun.file(path).text()) as Request;
    return typeof r?.id === "string" && typeof r.command?.kind === "string" ? r : undefined;
  } catch { return; } // a partial or foreign file
}

/**
 * Read and remove the queued requests `accept` takes (default: all), oldest
 * first; the others stay for a later pass. A request that cannot be read is
 * dropped, never retried.
 */
export async function takeRequests(project: string, accept: (kind: Command["kind"]) => boolean = () => true): Promise<Request[]> {
  const dir = commandsDir(project);
  const names = (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith(".json")).sort();
  const out: Request[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const r = await readRequest(path);
    if (r && !accept(r.command.kind)) continue;
    if (r) out.push(r);
    await unlink(path).catch(() => {});
  }
  return out;
}

export const acknowledge = (project: string, id: string, ok: boolean, message: string): Promise<void> =>
  publish(ackFile(project, id), JSON.stringify({ id, ok, message, at: new Date().toISOString() } satisfies Ack) + "\n");

/** Drop acks nobody collected within ACK_TTL_MS. */
export async function pruneAcks(project: string, now = Date.now()): Promise<void> {
  const dir = acksDir(project);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (s && now - s.mtimeMs > ACK_TTL_MS) await unlink(path).catch(() => {});
  }
}
