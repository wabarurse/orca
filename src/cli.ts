#!/usr/bin/env bun
// parallels / parallels start [project] [git-url]   open the TUI: one page per orchestrator (clones on first run;
//                                         run inside a git repo to get an orchestrator for it)
// parallels msg <project> <text>        drop a message in the orchestrator's inbox
// parallels pull                       update the dedicated harness clone from origin/main
// parallels version                    print the package.json version
// parallels agent --project p --role r [--branch b] [--run id]   internal: what spawn runs
// parallels agent-exit --project p --role r --branch b --run id --code n   internal: notice after a non-zero exit

import { pullHarness } from "./pull";
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
  const value = i === -1 ? undefined : rest[i + 1];
  return value?.startsWith("--") ? undefined : value;
}

function usage(error?: string): never {
  const write = error ? console.error : console.log;
  if (error) write(`parallels: ${error}`);
  write(`usage:
  parallels                            start for the repository in the current directory
  parallels start [project] [git-url]
  parallels msg <project> <text>
  parallels version
  parallels pull                       update ~/.parallels/app from origin/main
  parallels help | --help
  parallels agent --project <name> --role <orchestrator|worker|reviewer> [--branch <name>] [--run <id>]
  parallels agent-exit --project <name> --role <worker|reviewer> --branch <name> --run <id> --code <n>`);
  process.exit(error ? 1 : 0);
}

if (cmd !== "msg" && (rest.includes("--help") || rest.includes("-h"))) usage();

switch (cmd) {
  case undefined:
  case "start": {
    if (rest.length > 2 || rest.some((arg) => arg.startsWith("-"))) usage("expected start [project] [git-url]");
    if (!process.stdin.isTTY || !process.stdout.isTTY) usage("start requires an interactive terminal");
    const app = new App({
      term: realTerminal(),
      source: await repoHere(),
      async openOrchestrator(project, url, write, onInbox, tools) {
        await ensureProject(project, url);
        return createOrchestrator({ project, write, onInbox, ...tools });
      },
    });
    await app.run(rest[0], rest[1]);
    break;
  }
  case "msg": {
    const [project, ...words] = rest;
    if (!project || words.length === 0) usage("expected msg <project> <text>");
    await put(project, "orchestrator", { from: "user", text: words.join(" ") });
    break;
  }
  case "agent": {
    const project = flag("project") ?? usage("missing required internal command flag");
    const role = (flag("role") ?? usage("missing required internal command flag")) as Role;
    if (!["orchestrator", "worker", "reviewer"].includes(role)) usage("invalid agent role");
    process.exitCode = await runAgent({ project, role, branch: flag("branch"), run: flag("run") });
    break;
  }
  case "agent-exit": {
    const project = flag("project") ?? usage("missing required internal command flag");
    const role = (flag("role") ?? usage("missing required internal command flag")) as Role;
    if (!["worker", "reviewer"].includes(role)) usage("agent-exit requires worker or reviewer role");
    const branch = flag("branch") ?? usage("missing required internal command flag");
    const run = flag("run") ?? usage("missing required internal command flag");
    const code = Number(flag("code") ?? usage("missing required internal command flag"));
    if (!Number.isInteger(code) || code < 0 || code > 255) usage("invalid exit code");
    await afterExit({ project, id: sessionId(role, branch), run, role, branch, cwd: process.cwd(), code });
    break;
  }
  case "pull":
    if (rest.length) usage("pull takes no arguments; it only updates ~/.parallels/app");
    try { await pullHarness(); }
    catch (error) {
      console.error(`parallels pull: ${error instanceof Error ? error.message : String(error)}\nThe installed executable was not replaced on failure; the harness checkout/dependencies may have advanced. Inspect the error and retry after resolving it.`);
      process.exitCode = 1;
    }
    break;
  case "version":
    if (rest.length) usage("version takes no arguments");
    console.log(pkg.version);
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
  default:
    usage(`unknown command: ${cmd}`);
}
