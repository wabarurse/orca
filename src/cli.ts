#!/usr/bin/env bun
// parallels start <project> [git-url]   start the orchestrator REPL (clones on first run)
// parallels msg <project> <text>        drop a message in the orchestrator's inbox
// parallels version                    print the package.json version
// parallels agent --project p --role r [--branch b]   internal: what spawn runs

import pkg from "../package.json";
import { runAgent } from "./agent";
import { put } from "./inbox";
import { createOrchestrator, ensureProject } from "./orchestrator";
import { repl } from "./repl";
import type { Role } from "./transcript";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

function usage(): never {
  console.error(`usage:
  parallels start <project> [git-url]
  parallels msg <project> <text>
  parallels version
  parallels agent --project <name> --role <orchestrator|worker|reviewer> [--branch <name>]`);
  process.exit(1);
}

switch (cmd) {
  case "start": {
    const project = rest[0] ?? usage();
    await ensureProject(project, rest[1]);
    const orch = await createOrchestrator({ project });
    await repl(project, orch);
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
    await runAgent({ project, role, branch: flag("branch") });
    break;
  }
  case "version":
    console.log(pkg.version);
    break;
  default:
    usage();
}
