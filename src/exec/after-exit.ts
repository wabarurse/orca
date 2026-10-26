// The `orca agent-exit` follow-up: what the shell wrapper runs after an agent
// process ended with a non-zero code, over the run records in core/tmux/exits.ts.

import { stopTaskRun } from "../core/data/tasks";
import { claim, dirtyCount, markEnded, noticeText, readRun, sendNotice, type RunInfo } from "../core/tmux";

/**
 * The shell follow-up after a non-zero exit (`orca agent-exit`): a signal,
 * OOM or an uncaught error the agent could not report itself. Sends nothing if
 * the run is already closed or its last act was a report. Nothing either when
 * no run record carries this run id: the process died before beginRun, which
 * the launch check reports (runner.ts confirmLaunch, within its wait) or, past
 * that, the daemon's watchdog once the launch grace is over (recoverTaskRuns, the
 * run stays "prepared" until then); a second sender here would double them.
 */
export async function afterExit(info: RunInfo & { code: number }): Promise<boolean> {
  const s = await readRun(info.project, info.id);
  if (s?.run !== info.run) return false;
  // A hard kill never reached supervise's close; the end is about now.
  if (!s.endedAt) await markEnded(info.project, info.id, info.run).catch(() => {});
  try { await stopTaskRun(info.project, info.run, "unknown", `agent exited with code ${info.code}; not a readiness signal`); }
  catch (err) { console.error(`agent: could not update task: ${String(err)}`); }
  if (s.state === "reported") {
    await claim(info.project, info.id, info.run);
    return false;
  }
  const why = info.code > 128 ? `exited (code ${info.code}, signal ${info.code - 128})` : `exited (code ${info.code})`;
  return sendNotice(info.project, info.id, info.run, async () => noticeText(info.id, `${why} without reporting`, s, await dirtyCount(info.cwd)));
}
