#!/usr/bin/env bun
// orca2: argument parsing and dispatch.
import { BUILD_ID } from "../config";
import { conversationFor, listConversations, readConversation } from "../core/conversations";
import { removeConversation } from "../core/lifecycle";
import { runDaemon } from "../core/daemon/daemon";
import { ensureDaemon, say, stopDaemon } from "../core/daemon/client";
import { runHeadless } from "../core/headless";
import { registerBuiltins } from "../core/plugins";
import { agentProcess } from "../core/process/agent";
import { setTrust } from "../core/trust";
import { BUILTINS } from "../plugins";
import { runAccounts, runLogin } from "./login";
import { runMcp } from "./mcp";
import { PLUGIN_USAGE, runPlugin } from "./plugin";

const USAGE = `orca2 [start] [folder]            open the TUI for a folder's conversation
  orca2 -p "task" [--json] [--model m] [--cwd folder] [--conversation id] [--bundle name] [--yes] [--trust]
  orca2 msg "text" [--conversation id]  send input to a conversation's orchestrator
  orca2 stop [--conversation id]        stop its daemon
  orca2 list                            conversations
  orca2 delete --conversation id        stop its agents and remove it
  orca2 login anthropic|openai [profile] [--import]
  orca2 accounts
  orca2 trust [folder] | orca2 untrust [folder]
  orca2 mcp [test|login|logout] [name]
  ${PLUGIN_USAGE}
  orca2 version`;

const out = (text: string): void => { process.stdout.write(text); };

function option(args: string[], flag: string): string | null {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1] ?? null;
}

async function ask(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

async function conversationArg(args: string[]): Promise<string> {
  const given = option(args, "--conversation");
  if (given !== null) {
    if (await readConversation(given) === null) throw new Error(`no conversation ${given}`);
    return given;
  }
  return (await conversationFor(process.cwd())).id;
}

export async function main(argv: string[]): Promise<number> {
  registerBuiltins(BUILTINS);
  const [command, ...args] = argv;
  if (command === "-p" || command === "--print") {
    const prompt = args[0];
    if (prompt === undefined || prompt.length === 0) { out(`usage:\n  ${USAGE}\n`); return 2; }
    return runHeadless({ prompt, json: args.includes("--json"), model: option(args, "--model"), cwd: option(args, "--cwd") ?? process.cwd(),
      conversation: option(args, "--conversation"), bundle: option(args, "--bundle") ?? "orchestrator", yes: args.includes("--yes"), trust: args.includes("--trust"), out, resolve: null });
  }
  if (command === "agent") {
    const get = (flag: string): string => option(args, flag) ?? "";
    return agentProcess({ conversation: get("--conversation"), agent: get("--agent"), run: get("--run"), bundle: get("--bundle"), branch: get("--branch"), cwd: get("--cwd"), fresh: args.includes("--fresh") });
  }
  if (command === "daemon") {
    return runDaemon({ conversation: option(args, "--conversation") ?? "", run: option(args, "--run") ?? "", exitWhenIdle: args.includes("--exit-when-idle"), model: option(args, "--model"), log: out });
  }
  if (command === "msg") {
    const text = args[0] ?? "";
    if (text.length === 0) { out("usage: orca2 msg \"text\" [--conversation id]\n"); return 2; }
    const conversation = await conversationArg(args);
    await say(conversation, text, [], "steer");
    await ensureDaemon(conversation, null);
    out(`sent to ${conversation}\n`);
    return 0;
  }
  if (command === "stop") { await stopDaemon(await conversationArg(args)); return 0; }
  if (command === "delete") {
    const conversation = option(args, "--conversation");
    if (conversation === null) { out("usage: orca2 delete --conversation <id>  (stops its agents, removes its folder, $ORCA_DATA and worktrees)\n"); return 2; }
    await removeConversation(conversation, out);
    out(`deleted ${conversation}\n`);
    return 0;
  }
  if (command === "list") { for (const c of await listConversations()) out(`${c.id}  ${c.name.padEnd(16)} ${c.directory}\n`); return 0; }
  if (command === "login") return runLogin(args, out);
  if (command === "accounts") return runAccounts(out);
  if (command === "trust" || command === "untrust") { await setTrust(args[0] ?? process.cwd(), command === "trust"); out(`${command}ed ${args[0] ?? process.cwd()}\n`); return 0; }
  if (command === "mcp") { await runMcp(args, line => { out(`${line}\n`); }); return 0; }
  if (command === "plugin") return runPlugin(args, out, ask, process.stdin.isTTY === true);
  if (command === "version" || command === "--version") { out(`orca2 ${BUILD_ID}\n`); return 0; }
  if (command === "help" || command === "--help" || command === "-h") { out(`usage:\n  ${USAGE}\n`); return 0; }
  if (command === undefined || command === "start" || !command.startsWith("-")) {
    const { startTui } = await import("../tui/app");
    return startTui(command === "start" ? args[0] ?? process.cwd() : command ?? process.cwd());
  }
  out(`unknown command ${command}\nusage:\n  ${USAGE}\n`);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exit(code); }, (error: unknown) => {
    process.stderr.write(`orca2: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
