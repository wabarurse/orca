// The orchestrator daemon's process entry: `orca agent --role orchestrator`
// (exec/run.ts hands over here) takes the project's daemon lock, runs the poll
// loop in core/agent-loop/orc/daemon.ts under supervision and releases the lock.

import { paths } from "../config/config";
import type { AgentOptions } from "../core/agent-loop/loop/agent";
import { runDaemon, windowHooks, type DaemonOutcome } from "../core/agent-loop/orc/daemon";
import { liveWriter } from "../core/agent-loop/orc/live";
import { createOrchestrator } from "../core/agent-loop/orc/orchestrator";
import { tryStorageLock } from "../core/data/storage-lock";
import { open } from "../core/data/transcripts/transcript";
import { publishLaunch } from "../core/tmux/cancellation";
import { claim, supervise, type Tracker } from "../core/tmux/exits";
import { SETTLED_EXIT } from "../core/tmux/runner";

/**
 * `orca agent --role orchestrator`: one daemon per project, supervised like a
 * worker (run record, exit notice on a crash or a signal). A clean stop closes
 * its own run first, so no notice follows it; a project deleted underneath ends
 * the process at once, so nothing writes its files back. Returns the exit code.
 */
export async function orchestratorAgent(opts: AgentOptions & { run: string }, exit: (code: number) => void = code => process.exit(code)): Promise<number> {
  const { project, run } = opts;
  const release = await tryStorageLock(paths.daemonLock(project), project);
  if (!release) { console.error(`orca: an orchestrator is already running for ${project}`); return SETTLED_EXIT; }
  publishLaunch(project, "orchestrator", run); // the live daemon's run is what cancel requests must name, whoever launched last
  const info = { project, id: "orchestrator", run, role: "orchestrator" as const, cwd: process.cwd() };
  try {
    return await supervise(info, async (tracker: Tracker) => {
      const transcript = open(paths.transcript(project, "orchestrator"));
      const live = liveWriter({ project, run, head: () => transcript.head(), log: text => console.error(text) });
      const session = await createOrchestrator({ project, transcript, loadProvider: opts.loadProvider, rolling: opts.rolling, tracker, joinRolling: opts.exitWhenIdle, ...windowHooks(live) });
      let outcome: DaemonOutcome;
      try { outcome = await runDaemon({ project, run, session, live, exitWhenIdle: opts.exitWhenIdle }); }
      finally { session.dispose?.(); }
      if (outcome === "deleted") { await release(); exit(0); return new Promise<never>(() => {}); } // nothing after a real exit
      await claim(project, "orchestrator", run); // a clean stop is not an exit to report
    });
  } finally { await release(); }
}
