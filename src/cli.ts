#!/usr/bin/env bun
// parallels start <project>            start or attach to the orchestrator
// parallels msg <project> <text>       send a message to the orchestrator
// parallels agent --project p --role r [--task id]   internal: what spawn runs

import { runAgent } from "./agent";
import { put } from "./inbox";
import type { Role } from "./transcript";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

function usage(): never {
  console.error(`usage:
  parallels start <project>
  parallels msg <project> <text>
  parallels agent --project <name> --role <orchestrator|worker|reviewer> [--task <id>]`);
  process.exit(1);
}

switch (cmd) {
  case "start": {
    const project = rest[0] ?? usage();
    // TODO(PR7): ensure the project exists under ~/.parallels, start the
    // orchestrator via the runner, then drop into a thin REPL.
    console.log(`start ${project}: not implemented`);
    break;
  }
  case "msg": {
    const [project, ...words] = rest;
    if (!project || words.length === 0) usage();
    await put(project, { from: "user", text: words.join(" ") });
    break;
  }
  case "agent": {
    const project = flag("project") ?? usage();
    const role = (flag("role") ?? usage()) as Role;
    await runAgent({ project, role, taskId: flag("task") });
    break;
  }
  default:
    usage();
}
