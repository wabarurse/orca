// Compiled test entrypoint only: same runner/agent/exit code as the CLI, with a
// fake provider and fake tmux boundary. No production flags or provider overrides.
import { installedImages } from "./installed-images";
import { appendFileSync } from "node:fs";
import { local } from "../runner";
import { runAgent } from "../agent";
import { afterExit } from "../exits";
import { sessionId } from "../runner";
import { fakeProvider, text } from "./fake-provider";
import type { Role } from "../transcript";

const [cmd, ...args] = process.argv.slice(2);
const record = (entry: object) => appendFileSync(process.env.PROBE_LOG!, JSON.stringify(entry) + "\n");
const flag = (name: string) => args[args.indexOf(`--${name}`) + 1]!;
const project = flag("project"), role = flag("role") as Role, branch = flag("branch"), run = flag("run");
if (cmd === "images") {
  console.log(JSON.stringify(await installedImages()));
} else if (cmd === "launch") {
  await local.start({ project, role, branch: role === "orchestrator" ? undefined : branch, run });

} else if (cmd === "fake-tmux") {
  record({ tmux: args });
  if (args[0] === "has-session") process.exit(1);
  if (args[0] === "new-window") {
    const cwd = args[args.indexOf("-c") + 1]!;
    const child = Bun.spawn(args.slice(args.indexOf("--") + 1), { cwd, env: { ...process.env, FIXTURE_LOGIN: "stale-login", STALE_FIXTURE: "old" }, stdout: "ignore", stderr: "ignore" });
    record({ exit: await child.exited, cwd });
  }
} else if (cmd === "agent") {
  record({ cmd, args, cwd: process.cwd(), home: process.env.PARALLELS_HOME, executable: process.execPath, login: process.env.FIXTURE_LOGIN, stale: process.env.STALE_FIXTURE });
  if (process.env.PROBE_EXIT === "kill") process.kill(process.pid, "SIGKILL");
  else if (process.env.PROBE_EXIT) process.exit(Number(process.env.PROBE_EXIT));
  else {
    const provider = fakeProvider([[text("offline fixture response")]]);
    process.exitCode = await runAgent({ project, role, branch: role === "orchestrator" ? undefined : branch, run: role === "orchestrator" ? undefined : run, loadProvider: async () => provider });
    record({ providerCalls: provider.calls.length, role });
  }
} else if (cmd === "agent-exit") {
  record({ cmd, args, cwd: process.cwd(), home: process.env.PARALLELS_HOME, executable: process.execPath });
  await afterExit({ project, role, branch, run, id: sessionId(role, branch), cwd: process.cwd(), code: Number(flag("code")) });
  process.exitCode = Number(process.env.PROBE_FOLLOWUP_EXIT ?? 0);
} else throw new Error("unknown test probe command");
