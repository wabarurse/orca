// Run a short-lived command with a hard timeout: spawn, read its output,
// SIGKILL it when it takes too long. Shared by exit notices (git status) and
// the merge watcher (gh, git).

export interface ProcResult { code: number; out: string; err: string }
import { completeProcess } from "./process-completion";
import { AsyncLocalStorage } from "node:async_hooks";
const processScope = new AsyncLocalStorage<AbortSignal>();
export const withProcessScope = <T>(signal: AbortSignal, action: () => T): T => processScope.run(signal, action);

export { killGroup } from "./process-signals";
import { killGroup } from "./process-signals";

/** Run argv in cwd; null when it could not start; interrupted collection returns partial output and code -1. */
export async function run(argv: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal; attached?: boolean }): Promise<ProcResult | null> {
  const inherited = processScope.getStore();
  if (inherited) opts = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, inherited]) : inherited };
  opts.signal?.throwIfAborted();
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env ?? process.env, detached: !opts.attached, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  const kill = () => {
    if (!opts.attached) return killGroup(proc);
    try { proc.kill("SIGKILL"); return []; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? [] : [`process ${proc.pid}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`]; }
  };
  process.once("exit", kill);
  const chunks: Buffer[][] = [[], []];
  try {
    const completion = await completeProcess(proc, { timeoutMs: opts.timeoutMs, signal: opts.signal, kill,
      chunk: (bytes, stream) => { chunks[stream === "stdout" ? 0 : 1]!.push(Buffer.from(bytes)); } });
    opts.signal?.throwIfAborted();
    const diagnostic = [completion.reason, ...completion.cleanupErrors, completion.cleanupIncomplete ? "cleanup incomplete; command processes may still be running" : undefined].filter(Boolean).join("; ");
    return { code: diagnostic ? -1 : completion.code!, out: Buffer.concat(chunks[0]!).toString(), err: Buffer.concat(chunks[1]!).toString() + (diagnostic ? `\n[${diagnostic}]` : "") };
  } catch {
    opts.signal?.throwIfAborted();
    return null;
  } finally {
    process.off("exit", kill);
  }
}

/** Tool-owned commands throw on cancellation rather than reporting a normal failure. */
export async function command(argv: string[], cwd: string, signal?: AbortSignal): Promise<ProcResult> {
  const result = await run(argv, { cwd, signal, timeoutMs: 60_000 });
  if (!result) throw new Error(`${argv[0]} failed to start or timed out`);
  if (result.code === -1) throw new Error(`${argv[0]} collection failed: ${result.err.slice(-2000)}`);
  return result;
}
