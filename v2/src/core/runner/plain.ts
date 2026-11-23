import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fail } from "../../config";
import { pidAlive } from "../lock";
import type { Launch, Runner } from "../plugins/types";
import { launchCommand } from "./launch";
import { listRuns } from "./runs";

function terminateGroup(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { return; } }
}

export const plainRunner: Runner = {
  name: "plain",
  async start(launch: Launch) {
    mkdirSync(dirname(launch.log), { recursive: true, mode: 0o700 });
    const command = await launchCommand(launch);
    try {
      const proc = Bun.spawn(command.argv, { cwd: launch.cwd, env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
      proc.unref();
      return { handle: String(proc.pid), pid: proc.pid };
    } catch (error) {
      await command.cleanup();
      throw error;
    }
  },
  async alive(conversation: string) {
    return (await listRuns(conversation)).filter(run => run.runner === "plain" && run.pid !== null && pidAlive(run.pid)).map(run => run.agent);
  },
  async stop(conversation: string, agent: string) {
    const run = (await listRuns(conversation)).find(r => r.agent === agent);
    if (run === undefined) return;
    const leader = Number.parseInt(run.handle, 10);
    if (Number.isInteger(leader) && leader > 0) terminateGroup(leader);
    if (run.pid !== null && run.pid !== leader) terminateGroup(run.pid);
  },
  async screen() {
    return fail("the plain runner keeps no terminal; its output is in the log");
  },
  async send() {
    return fail("the plain runner keeps no terminal to type into; pick tmux or rex with /mux for new agents and commands");
  },
};
