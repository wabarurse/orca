import { killGroup } from "./cancellation";
// Run a short-lived command with a hard timeout: spawn, read its output,
// SIGKILL it when it takes too long. Shared by exit notices (git status) and
// the merge watcher (gh, git).

export interface ProcResult { code: number; out: string; err: string }

/** Run argv in cwd; null when it could not start, failed to read, or was killed after `timeoutMs`. */
export async function run(argv: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<ProcResult | null> {
  opts.signal?.throwIfAborted();
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  let timedOut = false;
  const kill = () => killGroup(proc);
  process.once("exit", kill);
  opts.signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    opts.signal?.throwIfAborted();
    return timedOut ? null : { code, out, err };
  } catch {
    opts.signal?.throwIfAborted();
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", kill);
    process.off("exit", kill);
  }
}

/** Tool-owned commands throw on cancellation rather than reporting a normal failure. */
export async function command(argv: string[], cwd: string, signal?: AbortSignal): Promise<ProcResult> {
  const result = await run(argv, { cwd, signal, timeoutMs: 60_000 });
  if (!result) throw new Error(`${argv[0]} failed to start or timed out`);
  return result;
}
