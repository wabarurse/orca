// Dormant: only a launch gate that retains branch ownership may enroll a pane.
// Never enroll by looking up the current window name when a stop is requested.
export interface InterruptTarget {
  project: string; task: string; branch: string; agent: string; run: string;
  token: string; // fresh UUID per launch, installed before execution is permitted
  pane: string; pid: number;
}
export type InterruptStatus = "agent-exited-cleanup-unverified" | "still-running" | "unknown";
export interface InterruptResult {
  status: InterruptStatus;
  warning: string;
}
export const bindingOption = "@orca_interrupt_binding";
const warning = "Ctrl+C may trigger existing hard-kill callbacks. Descendant cleanup is unverified; remote operations may continue. Retain branch ownership.";
/** The trusted launcher must set this pane option before opening its execution
 * gate, never reuse/respawn an enrolled pane, and serialize enrollment with stop.
 * The token is an incarnation guard, not a credential or termination proof.
 */
export function interruptBinding(t: InterruptTarget): string {
  if (!/^%\d+$/.test(t.pane) || !Number.isSafeInteger(t.pid) || t.pid <= 0 ||
      !/^[a-f0-9-]{36}$/.test(t.token) ||
      ![t.project, t.task, t.branch, t.agent, t.run].every(x => typeof x === "string" && x.length > 0 && x.length <= 500)) {
    throw new Error("invalid interrupt target");
  }
  return Buffer.from(JSON.stringify([t.project, t.task, t.branch, t.agent, t.run, t.token])).toString("base64url");
}
// argv prefix must name the launch's exact local tmux server/socket. No shell.
export type TmuxQuery = (args: string[], timeoutMs: number) => Promise<string | null>;
export function interruptClient(argv: string[]): TmuxQuery {
  const prefix = [...argv];
  return async (args, timeoutMs) => {
    let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
    try { proc = Bun.spawn([...prefix, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }); }
    catch { return null; }
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        Promise.all([proc.exited, new Response(proc.stdout).text()]).then(([code, out]) => code === 0 ? out.trim() : null),
        new Promise<null>(resolve => { timer = setTimeout(() => {
          // Only the client, never a pane/process group; no escalation.
          try { proc.kill("SIGTERM"); } catch { /* already exited */ }
          resolve(null);
        }, timeoutMs); }),
      ]);
    } catch { return null; }
    finally { clearTimeout(timer!); }
  };
}
/** No production callers. Does not cancel task bookkeeping, release ownership,
 * remove worktrees, respawn, or infer descendants gone from a missing pane.
 * if-shell -F avoids a shell subprocess and queues send-keys after evaluating
 * the format. This is NOT an OS identity guarantee or a lock against another
 * client respawning the pane between evaluation and delivery. Activation MUST
 * serialize launch/stop and prohibit respawn of enrolled panes.
 */
export async function interruptExactRun(target: InterruptTarget, query: TmuxQuery, waitMs = 1000): Promise<InterruptResult> {
  const t = structuredClone(target), binding = interruptBinding(t);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10_000) throw new Error("invalid observation bound");
  const result = (status: InterruptStatus): InterruptResult => ({ status, warning });
  const identity = `#{&&:#{==:#{${bindingOption}},${binding}},#{==:#{pane_pid},${t.pid}}}`;
  const state = `#{?${identity},#{?pane_dead,exited,running},unknown}`;
  // Dead panes must be retained by the launcher. Absence/errors remain unknown.
  const dispatch = await query(["if-shell", "-F", "-t", t.pane,
    `#{&&:${identity},#{==:#{pane_dead},0}}`,
    `send-keys -t ${t.pane} C-c ; display-message -p -t ${t.pane} sent`,
    `display-message -p -t ${t.pane} '${state}'`], 1000).catch(() => null);
  if (dispatch === "exited") return result("agent-exited-cleanup-unverified");
  if (dispatch !== "sent") return result("unknown");
  return result(await observeExit(t.pane, state, query, waitMs));
}

async function observeExit(pane: string, state: string, query: TmuxQuery, waitMs: number): Promise<InterruptStatus> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "unknown"; // sent is not liveness evidence
    const observed = await query(["display-message", "-p", "-t", pane, state], Math.min(1000, remaining)).catch(() => null);
    if (observed === "exited") return "agent-exited-cleanup-unverified";
    if (observed !== "running") return "unknown";
    const left = deadline - performance.now();
    if (left <= 25) return "still-running";
    await Bun.sleep(Math.min(25, left));
  }
}
