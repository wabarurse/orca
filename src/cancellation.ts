// Cross-process cancellation is scoped to exactly one transcript/session, never
// a branch (which can have both a worker and a reviewer).
import { readFileSync, renameSync, rmSync } from "node:fs";
import { paths } from "./config";

export class Cancelled extends Error {
  constructor() { super("Cancelled by user"); }
}

export async function cancelSession(project: string, id: string): Promise<void> {
  const path = `${paths.transcript(project, id)}.cancel`;
  const token = crypto.randomUUID();
  const tmp = `${path}.${token}.tmp`;
  let run: string | undefined;
  try { run = JSON.parse(readFileSync(`${paths.runs(project)}/${id}.json`, "utf8")).run; } catch { /* not yet supervised */ }
  try {
    await Bun.write(tmp, JSON.stringify({ token, run }));
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

/** A new run ignores old requests. Atomic tokens avoid timestamp/restart races. */
export function watchCancellation(project: string, id: string, controller: AbortController, run?: string): () => void {
  const path = `${paths.transcript(project, id)}.cancel`;
  const read = () => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
  const initial = read();
  const check = () => {
    const value = read();
    if (!value) return;
    try {
      const request = JSON.parse(value) as { run?: string };
      // A request during supervised startup is still for this run, even when
      // written before the watcher starts. Never cancel a subsequent respawn.
      if (run ? request.run === run : value !== initial) controller.abort(new Cancelled());
    } catch { /* incomplete/foreign request */ }
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
