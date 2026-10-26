// The orchestrator daemon's process entry: `orca agent --role orchestrator`
// (exec/run.ts hands over here) takes the project's daemon lock, runs the poll
// loop in core/agent-loop/orc/daemon.ts under supervision and releases the lock.

import { paths } from "../config";
import type { AgentOptions } from "../core/agent-loop/loop";
import { runDaemon, windowHooks, type DaemonOutcome } from "../core/agent-loop/orc";
import { liveWriter } from "../core/agent-loop/orc";
import { createOrchestrator } from "../core/agent-loop/orc";
import { tryStorageLock } from "../core/data";
import { open } from "../core/data/transcripts";
import { publishLaunch } from "../core/tmux";
import { ABANDONED, claim, supervise, type Tracker } from "../core/tmux";
import { SETTLED_EXIT } from "../core/tmux";

/**
 * `orca agent --role orchestrator`: one daemon per project, supervised like a
 * worker (run record, exit notice on a crash or a signal). A clean stop closes
 * its own run first, so no notice follows it; a project deleted underneath
 * abandons the run (nothing writes its files back) and, in the CLI process,
 * ends it at once through `exit`. In-process callers (tests) get the exit code
 * back instead: the daemon never calls process.exit itself. Returns the exit code.
 */
export async function orchestratorAgent(opts: AgentOptions & { run: string }, exit?: (code: number) => void): Promise<number> {
  const { project, run } = opts;
  const held = await tryStorageLock(paths.daemonLock(project), project);
  if (!held) { console.error(`orca: an orchestrator is already running for ${project}`); return SETTLED_EXIT; }
  // Once only: a second rm could take a recreated project's new lock with it.
  let released = false;
  const release = async () => { if (!released) { released = true; await held(); } };
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
      if (outcome === "deleted") { await release(); exit?.(0); return ABANDONED; } // a real exit returns nothing; in-process, the run is left unclosed
      await claim(project, "orchestrator", run); // a clean stop is not an exit to report
    });
  } finally { await release(); }
}
