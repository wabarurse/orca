#!/usr/bin/env bun
// parallels start [project] [git-url]   open the TUI: one page per orchestrator (clones on first run;
//                                         run inside a git repo to get an orchestrator for it)
// parallels msg <project> <text>        drop a message in the orchestrator's inbox
// parallels version                    print the package.json version
// parallels agent --project p --role r [--branch b] [--run id]   internal: what spawn runs
// parallels agent-exit --project p --role r --branch b --run id --code n   internal: notice after a non-zero exit

import pkg from "../package.json";
import { runAgent } from "./agent";
import { afterExit } from "./exits";
import { put } from "./inbox";
import { repoHere } from "./commands";
import { sessionId } from "./runner";
import { createOrchestrator, ensureProject } from "./orchestrator";
import type { Role } from "./transcript";
import { App } from "./tui/app";
import { realTerminal } from "./tui/term";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

function usage(): never {
  console.error(`usage:
  parallels start [project] [git-url]
  parallels msg <project> <text>
  parallels version
  parallels agent --project <name> --role <orchestrator|worker|reviewer> [--branch <name>] [--run <id>]
  parallels agent-exit --project <name> --role <worker|reviewer> --branch <name> --run <id> --code <n>`);
  process.exit(1);
}

switch (cmd) {
  case "start": {
    const app = new App({
      term: realTerminal(),
      source: await repoHere(),
      async openOrchestrator(project, url, write, report) {
        await ensureProject(project, url);
        return createOrchestrator({ project, write, report });
      },
    });
    await app.run(rest[0], rest[1]);
    break;
  }
  case "msg": {
    const [project, ...words] = rest;
    if (!project || words.length === 0) usage();
    await put(project, "orchestrator", { from: "user", text: words.join(" ") });
    break;
  }
  case "agent": {
    const project = flag("project") ?? usage();
    const role = (flag("role") ?? usage()) as Role;
    process.exitCode = await runAgent({ project, role, branch: flag("branch"), run: flag("run") });
    break;
  }
  case "agent-exit": {
    const project = flag("project") ?? usage();
    const role = (flag("role") ?? usage()) as Role;
    const branch = flag("branch") ?? usage();
    const run = flag("run") ?? usage();
    const code = Number(flag("code") ?? usage());
    await afterExit({ project, id: sessionId(role, branch), run, role, branch, cwd: process.cwd(), code });
    break;
  }
  case "version":
    console.log(pkg.version);
    break;
  default:
    usage();
}
