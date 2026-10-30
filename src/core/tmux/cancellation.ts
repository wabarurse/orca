// Cross-process cancellation targets exact launches, never a branch (which can
// have both a worker and a reviewer). An orchestrator target stops its whole tree.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stopTaskRun } from "../data/tasks";
import { paths } from "../../config";
import { execution } from "../data/projects/lifecycle";
import { readdir } from "node:fs/promises";
import { controlProcess, processDirectory, liveProcess, readProcess } from "../data/processes";

export class Cancelled extends Error {
  constructor() { super("cancelled by user"); }
}
const admission = (project: string, id: string, run: string) => join(paths.runtimeProject(project), "admissions", encodeURIComponent(id), `${encodeURIComponent(run)}.json`);

/** Publish before making a transcript/window selectable. Kept separate from the
 * supervisor state, which may still describe the previous process during launch. */
export function publishLaunch(project: string, id: string, run: string, epoch = execution.epoch(project)): void {
  const path = `${paths.transcript(project, id)}.launch`;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  const admitted = admission(project, id, run);
  mkdirSync(dirname(admitted), { recursive: true, mode: 0o700 });
  // Admission is published before the selectable launch. A delayed process may
  // never adopt a newer generation merely because a user has already resumed.
  try { writeFileSync(admitted, JSON.stringify({ run, epoch }), { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; launchEpoch(project, id, run); }
  try { writeFileSync(tmp, run); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
export function launchEpoch(project: string, id: string, run: string): string | undefined {
  try { const value = JSON.parse(readFileSync(admission(project, id, run), "utf8")); if (value.run !== run || typeof value.epoch !== "string") throw new Error("invalid admission"); return value.epoch; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("invalid launch execution record"); }
}
export function launchIdentity(project: string, id: string): string | undefined {
  try { return readFileSync(`${paths.transcript(project, id)}.launch`, "utf8") || undefined; }
  catch { return undefined; }
}
/** Cancel the exact launch. An orchestrator target also durably stops the entire conversation tree. */
export async function cancelSession(project: string, id: string, expectedRun?: string): Promise<string | undefined> {
  const run = expectedRun ?? launchIdentity(project, id);
  const failures: unknown[] = [];
  const collect = (results: PromiseSettledResult<unknown>[]) => { for (const result of results) if (result.status === "rejected") failures.push(result.reason); };
  if (id === "orchestrator") {
    await execution.stop(project);
    const stoppedEpoch = execution.epoch(project);
    // Existing workers may still be running the previous installed build. Send
    // their exact-run cancellation and command stop files as well as the barrier.
    const files = await readdir(dirname(paths.transcript(project, id))).catch(() => [] as string[]);
    collect(await Promise.allSettled(files.filter(name => /^(worker|reviewer)(-[A-Za-z0-9._-]+)?\.jsonl\.launch$/.test(name))
      .map(async name => {
        const agent = name.slice(0, -".jsonl.launch".length), target = launchIdentity(project, agent);
        if (!target || launchEpoch(project, agent, target) === stoppedEpoch) return;
        await cancelSession(project, agent, target);
      })));
    try {
      const ids = await readdir(processDirectory(project)).catch(error => { if (error.code === "ENOENT") return [] as string[]; throw error; });
      collect(await Promise.allSettled(ids.filter(id => /^[a-f0-9-]{36}$/.test(id)).map(async id => {
        const p = await readProcess(project, id);
        if (!liveProcess(p)) return;
        const admitted = await Bun.file(join(processDirectory(project, id), "execution-epoch")).text().catch(() => undefined);
        if (admitted === stoppedEpoch || (p.run && launchEpoch(project, p.owner, p.run) === stoppedEpoch)) return;
        await controlProcess(project, id, "stop").catch(async error => { if (liveProcess(await readProcess(project, id))) throw error; });
      })));
    } catch (error) { failures.push(error); }
  }
  if (!run) {
    if (failures.length) throw new AggregateError(failures, "conversation stop persisted, but some cancellation operations failed");
    return; // historical transcript, not a launch; never wildcard a future run
  }
  const path = `${paths.transcript(project, id)}.cancel`;
  const token = crypto.randomUUID();
  const tmp = `${path}.${token}.tmp`;
  try {
    await Bun.write(tmp, JSON.stringify({ token, run }));
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  try { await stopTaskRun(project, run, "cancelled", "cancelled by user; leave stopped until explicitly authorized to continue"); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "cancellation published, but some task or command updates failed");
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
  const admitted = launchEpoch(project, id, run) ?? execution.epoch(project);
  const check = () => {
    if (execution.stale(project, admitted)) { controller.abort(new Cancelled()); return; }
    try {
      const request = JSON.parse(readFileSync(path, "utf8")) as { run?: string };
      if (run && request.run === run) controller.abort(new Cancelled());
    } catch { /* absent/incomplete/foreign request */ }
  };
  check();
  const timer = setInterval(check, 100);
  return () => clearInterval(timer);
}

/** Resolves after `ms`, or rejects with the signal's reason. An already-aborted signal rejects too, never
 * throws synchronously: callers chain `.catch` on the returned promise and a throw would bypass it. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal!.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
