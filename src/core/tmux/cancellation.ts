// Cross-process cancellation is scoped to exactly one transcript/session, never
// a branch (which can have both a worker and a reviewer).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stopTaskRun } from "../data/tasks/tasks";
import { paths } from "../../config/config";

export class Cancelled extends Error {
  constructor() { super("cancelled by user"); }
}

/** Publish before making a transcript/window selectable. Kept separate from the
 * supervisor state, which may still describe the previous process during launch. */
export function publishLaunch(project: string, id: string, run: string): void {
  const path = `${paths.transcript(project, id)}.launch`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(tmp, run); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
export function launchIdentity(project: string, id: string): string | undefined {
  try { return readFileSync(`${paths.transcript(project, id)}.launch`, "utf8") || undefined; }
  catch { return undefined; }
}
/** Request cancellation of `id`'s current launch; returns the request's token (the orchestrator daemon acknowledges it under that id, src/core/agent-loop/orc/channel.ts). */
export async function cancelSession(project: string, id: string): Promise<string | undefined> {
  const run = launchIdentity(project, id);
  if (!run) return; // historical transcript, not a launch; never wildcard a future run
  const path = `${paths.transcript(project, id)}.cancel`;
  const token = crypto.randomUUID();
  const tmp = `${path}.${token}.tmp`;
  try {
    await Bun.write(tmp, JSON.stringify({ token, run }));
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  await stopTaskRun(project, run, "cancelled", "cancelled by user; leave stopped until explicitly authorized to continue");
  return token;
}

/**
 * Consume a pending request for this exact run: the file is moved aside atomically
 * first, so a request published meanwhile stays for the next check. Returns its
 * token, or undefined when there is none (or it names another run, which stays).
 * The orchestrator daemon takes requests this way because it outlives its turns.
 */
export function takeCancellation(project: string, id: string, run: string): string | undefined {
  const path = `${paths.transcript(project, id)}.cancel`;
  let request: { token?: string; run?: string };
  try { request = JSON.parse(readFileSync(path, "utf8")); }
  catch { return; }
  if (!run || request.run !== run || typeof request.token !== "string") return;
  const taken = `${path}.${request.token}.taken`;
  try { renameSync(path, taken); }
  catch { return; } // gone or replaced meanwhile
  try {
    const moved = JSON.parse(readFileSync(taken, "utf8")) as { token?: string; run?: string };
    return moved.run === run && typeof moved.token === "string" ? moved.token : undefined;
  } catch { return; }
  finally { rmSync(taken, { force: true }); }
}

/** Only the exact launch can accept its request, including requests before startup. */
export function watchCancellation(project: string, id: string, controller: AbortController, run: string): () => void {
  const path = `${paths.transcript(project, id)}.cancel`;
  const check = () => {
    try {
      const request = JSON.parse(readFileSync(path, "utf8")) as { run?: string };
      if (run && request.run === run) controller.abort(new Cancelled());
    } catch { /* absent/incomplete/foreign request */ }
  };
  check();
  const timer = setInterval(check, 100);
  return () => clearInterval(timer);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal!.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
