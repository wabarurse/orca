// Run a short-lived command with a hard timeout: spawn, read its output,
// SIGKILL it when it takes too long. Shared by exit notices (git status) and
// the merge watcher (gh, git).

export interface ProcResult { code: number; out: string; err: string }

/** Run argv in cwd; null when it could not start, failed to read, or was killed after `timeoutMs`. */
export async function run(argv: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> }): Promise<ProcResult | null> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, opts.timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return timedOut ? null : { code, out, err };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
