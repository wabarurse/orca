#!/usr/bin/env bun
import type { Role } from "../types";
import { assertLayout } from "../config";
import { readProcess, superviseProcess, watchPRChecks } from "../core/data/processes";
// orca / orca start [project] [directory]   open the TUI: one page per orchestrator (binds the original checkout;
//                                         run inside a git repo to get an orchestrator for it)
// orca msg <project> <text>        drop a message in the orchestrator's inbox
// orca stop <project>             stop the project's orchestrator daemon (its tmux window); the TUI restarts it on its next open
// orca pull                       update the dedicated harness clone from origin/main
// orca mcp [test|login|logout] [name]                 the MCP servers in ~/.orca/mcp.json (see docs/MCP.md)
// orca version                    print the package.json version
// orca agent --project p --role r [--branch b] [--run id]   internal: what spawn (and the TUI, for the orchestrator daemon) runs
// orca agent-exit --project p --role r --branch b --run id --code n   internal: notice after a non-zero exit (branch "" for the orchestrator)

import { ghTaskPR } from "../core/data/tasks";
import { cleanStorage, pull, runMcp } from "./scripts";
import pkg from "../../package.json";
import { afterExit, runAgent } from "../exec";
import { put } from "../core/data/inbox";
import { directories, repoHere, validProjectName } from "../core/data/projects";
import { execution } from "../core/data/projects/lifecycle";
import { existsSync } from "node:fs";
import { paths, BUILD_ID, loadConfig, saveConfig } from "../config";
import { daemonPid, reloadRunningDaemons, requireCurrentDaemon } from "../core/agent-loop/orc";
import { cliCommand, sessionId } from "../core/tmux";
import { ensureProject } from "../core/agent-loop/orc";
import { createClientOrchestrator, daemonKeeper, ensureDaemon, stopDaemon } from "../core/agent-loop/orc";
import { App } from "../tui";
import { realTerminal } from "../tui/components";

const [cmd, ...rest] = process.argv.slice(2);
if (["", "start", "startup", "msg", "stop", "agent", "agent-exit", "process-supervisor", "watch-pr-checks", "clean", "pull", "reload", "mcp"].includes(cmd ?? "")) assertLayout(paths.root);

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
  orca startup <conversation-name|--all>  choose conversations restored on startup
  orca clean [--preview]          delete eligible archived storage; --preview lists without deleting
  orca msg <project> <text>
  orca stop <project>             stop its orchestrator daemon (workers keep running)
  orca mcp [test [name] | login <name> | logout <name>]   the mcp servers in ~/.orca/mcp.json
  orca version
  orca pull                       update ~/.orca/.runtime/app from origin/main
  orca help | --help
  orca agent --project <name> --role <orchestrator|worker|reviewer> [--branch <name>] [--run <id>]
  orca agent-exit --project <name> --role <worker|reviewer> --branch <name> --run <id> --code <n>`);
  process.exit(error ? 1 : 0);
}

if (cmd !== "msg" && (rest.includes("--help") || rest.includes("-h"))) usage();

switch (cmd) {
  case "clean": {
    // Keep old explicit flags as aliases, particularly --dry-run's non-destructive meaning.
    if (rest.length > 1 || rest.some(arg => !["--preview", "--apply", "--dry-run"].includes(arg))) usage("clean accepts --preview (or legacy --dry-run / --apply)");
    console.log(JSON.stringify(await cleanStorage(!rest.includes("--preview") && !rest.includes("--dry-run")), null, 2));
    break;
  }
  case "startup": {
    if (rest.length !== 1) usage("startup requires a conversation name or --all");
    const selected = await directories.selectStartupConversations(rest[0]!);
    console.log(`startup will restore ${selected.length} conversation(s): ${selected.join(", ")}; other history is preserved`);
    break;
  }
  case "watch-pr-checks": {
    const project = flag("project") ?? usage("missing process project");
    const id = flag("process") ?? usage("missing process identity");
    const record = await readProcess(project, id);
    if (!record.prChecks || record.supervisorPid !== process.ppid) usage("PR watch requires its process supervisor");
    const watch = record.prChecks;
    process.exitCode = await watchPRChecks(watch, () => ghTaskPR(project, watch, { attached: true }));
    break;
  }
  case "process-supervisor": {
    const project = flag("project") ?? usage("missing process project");
    const id = flag("process") ?? usage("missing process identity");
    await superviseProcess(project, id, cliCommand());
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
      vim: (await loadConfig()).vim,
      saveVim: async on => { await saveConfig({ vim: on }); },
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
    await pull();
    break;
  case "mcp": await runMcp(rest).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }); break;
  case "reload": // internal: orca pull starts it, detached, in the build it just installed
    if (rest.length) usage("reload takes no arguments");
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
