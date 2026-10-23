// Cross-process cancellation is scoped to exactly one transcript/session, never
// a branch (which can have both a worker and a reviewer).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stopTaskRun } from "./tasks";
import { paths } from "./config";

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
export async function cancelSession(project: string, id: string): Promise<void> {
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

/** A shell and its ordinary descendants share a detached process group. */
export function killGroup(proc: { pid: number; kill(signal: "SIGKILL"): void }): void {
  try { process.kill(-proc.pid, "SIGKILL"); }
  catch { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }
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
