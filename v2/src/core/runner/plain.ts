// The core runner: an agent is a detached child process whose output goes to its log file. Runner plugins (tmux,
// rex) start the same command in a window you can watch.
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { pidAlive } from "../lock";
import type { Launch, Runner } from "../plugins/types";
import { listRuns } from "./runs";

export const plainRunner: Runner = {
  name: "plain",
  async start(launch: Launch) {
    mkdirSync(dirname(launch.log), { recursive: true, mode: 0o700 });
    const fd = openSync(launch.log, "a", 0o600);
    try {
      const proc = Bun.spawn(launch.argv, { cwd: launch.cwd, env: launch.env, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
      proc.unref();
      return { handle: String(proc.pid), pid: proc.pid };
    } finally { closeSync(fd); }
  },
  async alive(conversation: string) {
    return (await listRuns(conversation)).filter(run => run.runner === "plain" && run.pid !== null && pidAlive(run.pid)).map(run => run.agent);
  },
  async stop(conversation: string, agent: string) {
    const run = (await listRuns(conversation)).find(r => r.agent === agent);
    if (run?.pid == null) return;
    try { process.kill(-run.pid, "SIGTERM"); } catch { try { process.kill(run.pid, "SIGTERM"); } catch { /* gone */ } }
  },
};
