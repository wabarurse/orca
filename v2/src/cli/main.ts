#!/usr/bin/env bun
import { BUILD_ID, errorMessage, fail, ok, type Result } from "../config";
import { conversationFor, listConversations, readConversation } from "../core/conversations";
import { removeConversation } from "../core/lifecycle";
import { runDaemon } from "../core/daemon/daemon";
import { ensureDaemon, say } from "../core/daemon/client";
import { runHeadless } from "../core/headless";
import { agentProcess } from "../core/process/agent";
import { command as coreCommand } from "../core/commands";
import { runCommand } from "./commands";
import { runMcp } from "./mcp";
import { agentGuide, USAGE } from "./guide";
import { runPlugin } from "./plugin";
import { runSpans } from "./spans";
import { listBubbles, setBubbleDirectory } from "../core/bubbles";
import { runClean } from "./scripts/clean";
import { pull } from "./scripts/pull";
import { reloadRunningDaemons } from "../core/install";

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

async function conversationArg(args: string[]): Promise<Result<string>> {
  const given = option(args, "--conversation") ?? process.env.ORCA_CONVERSATION ?? null;
  if (given !== null) {
    if (await readConversation(given) === null) return fail(`no conversation ${given}`);
    return ok(given);
  }
  return ok((await conversationFor(process.cwd())).id);
}

function refuse(error: string): number {
  process.stderr.write(`orca2: ${error}\n`);
  return 1;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "-p" || command === "--print") {
    const prompt = args[0];
    if (prompt === undefined || prompt.length === 0) { out(`usage:\n  ${USAGE}\n`); return 2; }
    return runHeadless({ prompt, json: args.includes("--json"), model: option(args, "--model"), cwd: option(args, "--cwd") ?? process.cwd(),
      conversation: option(args, "--conversation"), bundle: option(args, "--bundle") ?? "orchestrator", yes: args.includes("--yes"), out, resolve: null });
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
    const picked = await conversationArg(args);
    if (!picked.ok) return refuse(picked.error);
    const conversation = picked.data;
    await say(conversation, text, [], "steer");
    const started = await ensureDaemon(conversation, null);
    if (!started.ok) return refuse(started.error);
    out(`sent to ${conversation}\n`);
    return 0;
  }
  if (command === "delete") {
    const conversation = option(args, "--conversation");
    if (conversation === null) { out("usage: orca2 delete --conversation <id>  (stops its agents, removes its folder, $ORCA_DATA and worktrees)\n"); return 2; }
    const removed = await removeConversation(conversation, out);
    if (!removed.ok) return refuse(removed.error);
    out(`deleted ${conversation}\n`);
    return 0;
  }
  if (command === "bubbles") {
    for (const b of await listBubbles()) out(`${b.id}  ${b.name.padEnd(20)} ${b.directory ?? "(no home folder)"}\n`);
    return 0;
  }
  if (command === "bubble") {
    const which = args[0], dir = option(args, "--dir");
    if (which === undefined || which.startsWith("--") || dir === null) { out("usage: orca2 bubble <name|id> --dir <folder>\n"); return 2; }
    const matches = (await listBubbles()).filter(b => b.id === which || b.name === which);
    if (matches.length !== 1) return refuse(matches.length === 0 ? `no bubble ${which}` : `${matches.length} bubbles are named ${which}; use its id`);
    const target = matches[0];
    if (target === undefined) return refuse(`no bubble ${which}`);
    const moved = await setBubbleDirectory(target.id, dir);
    if (!moved.ok) return refuse(moved.error);
    out(`${moved.data.name} → ${moved.data.directory ?? ""}\n`);
    return 0;
  }
  if (command === "spans") {
    const named = args[0] !== undefined && !args[0].startsWith("-") ? args[0] : null;
    const picked = named !== null ? ok(named) : await conversationArg(args);
    if (!picked.ok) return refuse(picked.error);
    return runSpans(picked.data, args.includes("--json"), out);
  }
  if (command === "list") { for (const c of await listConversations()) out(`${c.id}  ${c.name.padEnd(16)} ${c.directory}\n`); return 0; }
  if (command === "mcp") return runMcp(args, line => { out(`${line}\n`); });
  if (command === "plugin") return runPlugin(args, out, ask, process.stdin.isTTY === true);
  if (command === "clean") return runClean(args, out);
  if (command === "pull") {
    if (args.length > 0) { out("pull takes no arguments; it only updates ~/.orca2/.runtime/app\n"); return 2; }
    const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
    return pull({ write: text => process.stdout.write(text), isTTY: process.stdout.isTTY }, { write: text => process.stderr.write(text), isTTY: process.stderr.isTTY }, colour);
  }
  if (command === "reload") {
    if (args.length > 0) { out("reload takes no arguments\n"); return 2; }
    await reloadRunningDaemons();
    return 0;
  }
  if (command === "skill") { out(await agentGuide(process.env.ORCA_CONVERSATION ?? null)); return 0; }
  if (command === "version" || command === "--version") { out(`orca2 ${BUILD_ID}\n`); return 0; }
  if (command === "help" || command === "--help" || command === "-h") { out(`usage:\n  ${USAGE}\n`); return 0; }
  const core = command === undefined ? null : coreCommand(command);
  if (core !== null) return runCommand(core, args, out, text => { process.stderr.write(text); });
  if (command === undefined || command === "start" || !command.startsWith("-")) {
    const { startTui } = await import("../tui/app");
    return startTui(command === "start" ? args[0] ?? process.cwd() : command ?? process.cwd());
  }
  out(`unknown command ${command}\nusage:\n  ${USAGE}\n`);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => { process.exit(code); }, (error: unknown) => {
    process.stderr.write(`orca2: ${errorMessage(error)}\n`);
    process.exit(1);
  });
}
