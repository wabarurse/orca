#!/usr/bin/env bun
import { assertLayout } from "../config";
import { superviseProcess } from "../core/data/processes";
// orca / orca start [project] [directory]   open the TUI: one page per orchestrator (binds the original checkout;
//                                         run inside a git repo to get an orchestrator for it)
// orca msg <project> <text>        drop a message in the orchestrator's inbox
// orca stop <project>             stop the project's orchestrator daemon (its tmux window); the TUI restarts it on its next open
// orca pull                       update the dedicated harness clone from origin/main
// orca version                    print the package.json version
// orca agent --project p --role r [--branch b] [--run id]   internal: what spawn (and the TUI, for the orchestrator daemon) runs
// orca agent-exit --project p --role r --branch b --run id --code n   internal: notice after a non-zero exit (branch "" for the orchestrator)

import { pullHarness } from "../core/install";
import pkg from "../../package.json";
import { runAgent, scheduleReload, activateInstalled } from "../exec";
import { afterExit } from "../exec";
import { put } from "../core/data/inbox";
import { repoHere, validProjectName } from "../core/data/projects";
import { execution } from "../core/data/projects/lifecycle";
import { existsSync } from "node:fs";
import { paths, BUILD_ID } from "../config";
import { daemonPid, reloadRunningDaemons, requireCurrentDaemon } from "../core/agent-loop/orc";
import { sessionId } from "../core/tmux";
import { ensureProject } from "../core/agent-loop/orc";
import { createClientOrchestrator, daemonKeeper, ensureDaemon, stopDaemon } from "../core/agent-loop/orc";
import type { Role } from "../protocol";
import { App } from "../tui";
import { realTerminal } from "../tui/components";

const [cmd, ...rest] = process.argv.slice(2);
if (["", "start", "msg", "stop", "agent", "agent-exit", "pull", "reload", "apply-update"].includes(cmd ?? "")) assertLayout(paths.root);

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
  orca pull                       update ~/.orca/.runtime/app from origin/main
  orca reload                     apply the installed build to running orchestrators after their current turns
  orca help | --help
  orca agent --project <name> --role <orchestrator|worker|reviewer> [--branch <name>] [--run <id>]
  orca agent-exit --project <name> --role <worker|reviewer> --branch <name> --run <id> --code <n>`);
  process.exit(error ? 1 : 0);
}

if (cmd !== "msg" && (rest.includes("--help") || rest.includes("-h"))) usage();

switch (cmd) {
  case "process-supervisor": {
    const project = flag("project") ?? usage("missing process project");
    const id = flag("process") ?? usage("missing process identity");
    await superviseProcess(project, id);
    break;
  }
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
    const wasStopped = execution.stopped(project);
    if (!wasStopped) await requireCurrentDaemon(project);
    await put(project, "orchestrator", { from: "user", text: words.join(" ") });
    if (wasStopped) await ensureDaemon(project);
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
    process.exitCode = await runAgent({ project, role, branch: flag("branch"), run: flag("run") }, code => process.exit(code));
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
    if (rest.length) usage("pull takes no arguments; it only updates ~/.orca/.runtime/app");
    try {
      const binary = await pullHarness();
      await activateInstalled(binary);
    }
    catch (error) {
      console.error(`orca pull: ${error instanceof Error ? error.message : String(error)}\nthe installed executable was not replaced on failure; the harness checkout/dependencies may have advanced. inspect the error and retry after resolving it.`);
      process.exitCode = 1;
    }
    break;
  case "reload":
    if (rest.length) usage("reload takes no arguments; it applies the installed build to all running orchestrators");
    console.log(scheduleReload());
    break;
  case "apply-update":
    if (rest.length) usage("apply-update takes no arguments");
    await reloadRunningDaemons();
    break;
  case "version":
    if (rest.length) usage("version takes no arguments");
    console.log(`${pkg.version} (${BUILD_ID})`);
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
  default:
    usage(`unknown command: ${cmd}`);
}
