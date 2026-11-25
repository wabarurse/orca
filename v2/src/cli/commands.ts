import { fail, ok, type Result } from "../config";
import type { CoreCommand, CommandContext } from "../core/commands";
import { listConversations, readConversation, type Conversation } from "../core/conversations";
import { ensureDaemon } from "../core/daemon/client";
import { stopAgents } from "../core/runner/runtime";

type Out = (text: string) => void;

export async function cliConversation(given: string | null, cwd: string): Promise<Result<Conversation>> {
  const id = given ?? process.env.ORCA_CONVERSATION ?? null;
  if (id !== null) {
    const found = await readConversation(id);
    return found === null ? fail(`no conversation ${id}`) : ok(found);
  }
  const here = (await listConversations()).find(c => c.directory === cwd);
  return here === undefined ? fail(`no conversation for ${cwd}; pass --conversation id (orca2 list shows them)`) : ok(here);
}

export function cliContext(given: string | null, cwd: string, out: Out): CommandContext {
  return {
    conversation: () => cliConversation(given, cwd),
    directory: cwd,
    ensureDaemon: conversation => ensureDaemon(conversation, null),
    stopAgents,
    write: text => { out(`${text}\n`); },
    openBrowser: async url => { Bun.spawn(process.platform === "darwin" ? ["open", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); },
    signal: null,
  };
}

export function splitArgs(args: string[]): { positional: string[]; conversation: string | null } {
  const positional: string[] = [];
  let conversation: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--conversation") { conversation = args[i + 1] ?? ""; i++; } else positional.push(arg);
  }
  return { positional, conversation };
}

export async function runCommand(c: CoreCommand, args: string[], out: Out, err: Out): Promise<number> {
  const run = c.run;
  if (run === null) { err(`orca2: /${c.name} is TUI-only: ${c.description}\n`); return 2; }
  const { positional, conversation } = splitArgs(args);
  const ctx = cliContext(conversation === "" ? null : conversation, process.cwd(), out);
  if (positional.length === 0 && c.ask !== null) {
    if (c.ask.kind === "input") { err(`usage: orca2 ${c.name} ${c.args}\n`); return 2; }
    const listed = await c.ask.choices(ctx);
    if (!listed.ok) { err(`orca2: ${listed.error}\n`); return 1; }
    out(`${listed.data.title.split("   ")[0] ?? c.name}; orca2 ${c.name} ${c.args} sets one:\n`);
    for (const choice of listed.data.choices) out(`${choice.current ? "*" : " "} ${choice.value}${choice.detail.length > 0 ? `  ${choice.detail}` : ""}\n`);
    return 0;
  }
  const done = await run(positional, ctx);
  if (!done.ok) { err(`orca2: ${done.error}\n`); return 1; }
  out(`${done.data}\n`);
  return 0;
}
