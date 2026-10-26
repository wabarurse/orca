#!/usr/bin/env bun
// orca / orca start [project] [directory]   open the TUI: one page per orchestrator (binds the original checkout;
//                                         run inside a git repo to get an orchestrator for it)
// orca msg <project> <text>        drop a message in the orchestrator's inbox
// orca stop <project>             stop the project's orchestrator daemon (its tmux window); the TUI restarts it on its next open
// orca pull                       update the dedicated harness clone from origin/main
// orca version                    print the package.json version
// orca agent --project p --role r [--branch b] [--run id]   internal: what spawn (and the TUI, for the orchestrator daemon) runs
// orca agent-exit --project p --role r --branch b --run id --code n   internal: notice after a non-zero exit (branch "" for the orchestrator)

import { pullHarness } from "./pull";
import pkg from "../package.json";
import { runAgent } from "./agent";
import { afterExit } from "./exits";
import { put } from "./inbox";
import { repoHere, validProjectName } from "./commands";
import { existsSync } from "node:fs";
import { paths } from "./config";
import { daemonPid } from "./orchestrator-channel";
import { sessionId } from "./runner";
import { ensureProject } from "./orchestrator";
import { createClientOrchestrator, daemonKeeper, stopDaemon } from "./orchestrator-client";
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
  if (error) write(`orca: ${error}`);
  write(`usage:
  orca                            start for the repository in the current directory
  orca start [project] [directory]
  orca msg <project> <text>
  orca stop <project>             stop its orchestrator daemon (workers keep running)
  orca version
  orca pull                       update ~/.orca/app from origin/main
  orca help | --help
  orca agent --project <name> --role <orchestrator|worker|reviewer> [--branch <name>] [--run <id>]
  orca agent-exit --project <name> --role <worker|reviewer> --branch <name> --run <id> --code <n>`);
  process.exit(error ? 1 : 0);
}

if (cmd !== "msg" && (rest.includes("--help") || rest.includes("-h"))) usage();

switch (cmd) {
  case undefined:
  case "start": {
    if (rest.length > 2 || rest.some((arg) => arg.startsWith("-"))) usage("expected start [project] [directory]");
    if (!process.stdin.isTTY || !process.stdout.isTTY) usage("start requires an interactive terminal");
    const closing = new AbortController(); // quitting abandons a daemon launch still being confirmed
    const app = new App({
      term: realTerminal(),
      source: await repoHere(),
      ensureDaemon: daemonKeeper({ signal: closing.signal }),
      async openOrchestrator(project, url, write, _onInbox, tools) {
        await ensureProject(project, url);
        // A client of the project's orchestrator daemon: it runs no turn itself.
        return createClientOrchestrator({ project, onRefresh: tools?.onRefresh, notice: tools?.notice ?? (line => write(`${line}\n`, true)),
          write, onTool: tools?.onTool, onToolResult: tools?.onToolResult });
      },
    });
    try { await app.run(rest[0], rest[1]); }
    finally { closing.abort(); }
    break;
  }
  case "msg": {
    const [project, ...words] = rest;
    if (!project || words.length === 0) usage("expected msg <project> <text>");
    await put(project, "orchestrator", { from: "user", text: words.join(" ") });
    break;
  }
  case "stop": {
    const [project, ...extra] = rest;
    if (!project || extra.length || !validProjectName(project)) usage("expected stop <project>");
    if (!existsSync(paths.project(project))) usage(`no project named ${project}`);
    try {
      const pid = await daemonPid(project);
      await stopDaemon(project);
      console.log(pid === undefined ? `${project}: no orchestrator daemon is running` : `${project}: orchestrator daemon (pid ${pid}) stopped`);
    } catch (error) {
      console.error(`orca stop: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
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
    if (!["orchestrator", "worker", "reviewer"].includes(role)) usage("invalid agent-exit role");
    const branch = flag("branch") ?? usage("missing required internal command flag");
    if (role === "orchestrator" ? branch !== "" : !branch) usage("agent-exit takes a task branch for workers and reviewers only");
    const run = flag("run") ?? usage("missing required internal command flag");
    const code = Number(flag("code") ?? usage("missing required internal command flag"));
    if (!Number.isInteger(code) || code < 0 || code > 255) usage("invalid exit code");
    await afterExit({ project, id: sessionId(role, branch), run, role, branch, cwd: process.cwd(), code });
    break;
  }
  case "pull":
    if (rest.length) usage("pull takes no arguments; it only updates ~/.orca/app");
    try { await pullHarness(); }
    catch (error) {
      console.error(`orca pull: ${error instanceof Error ? error.message : String(error)}\nthe installed executable was not replaced on failure; the harness checkout/dependencies may have advanced. inspect the error and retry after resolving it.`);
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
