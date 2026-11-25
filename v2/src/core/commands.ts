import { accounts, parseLogin, signIn, type Account } from "../api/auth";
import { fail, loadConfig, ok, saveConfig, type Result } from "../config";
import type { Conversation } from "./conversations";
import { compactNow, stopDaemon } from "./daemon/client";
import { renameConversation } from "./lifecycle";
import { enabledUis } from "./plugins/uis";
import { chooseRunner, runnerNames } from "./runner/runtime";
import { accountChoices, effortChoices, fastChoices, learnModel, modelChoices, setEffort, setFast, setModel, useAccount, type Choice } from "./settings";
import { setTrust } from "./trust";

export type CommandContext = {
  conversation: () => Promise<Result<Conversation>>;
  directory: string;
  ensureDaemon: (conversation: string) => Promise<Result<number>>;
  write: (text: string) => void;
  openBrowser: (url: string) => Promise<void>;
  signal: AbortSignal | null;
};

export type Choices = { title: string; choices: Choice<string>[] };
export type Ask =
  | { kind: "pick"; choices: (ctx: CommandContext) => Promise<Result<Choices>> }
  | { kind: "input"; prompt: string; initial: (ctx: CommandContext) => Promise<string> };
export type Run = (args: string[], ctx: CommandContext) => Promise<Result<string>>;
export type CoreCommand = { name: string; args: string; description: string; scoped: boolean; ask: Ask | null; run: Run | null };

const modelOf = async (conversation: Conversation): Promise<string> => conversation.model ?? (await loadConfig()).model;

function withConversation<T>(use: (conversation: Conversation, ctx: CommandContext) => Promise<Result<T>>): (ctx: CommandContext) => Promise<Result<T>> {
  return async ctx => {
    const conversation = await ctx.conversation();
    return conversation.ok ? use(conversation.data, ctx) : conversation;
  };
}

const one = (args: string[]): string => args.join(" ").trim();

async function setModelCommand(args: string[], ctx: CommandContext): Promise<Result<string>> {
  const wanted = one(args);
  if (wanted.length === 0) return fail("usage: model <model>");
  return withConversation(async conversation => {
    const saved = await setModel(conversation, wanted);
    return saved.ok ? ok(`model ${wanted} from the next request`) : saved;
  })(ctx);
}

async function effortCommand(args: string[], ctx: CommandContext): Promise<Result<string>> {
  const level = one(args);
  if (level.length === 0) return fail("usage: effort <level|default>");
  return withConversation(async conversation => {
    const model = await modelOf(conversation);
    await learnModel(model);
    const saved = await setEffort(conversation, level);
    return saved.ok ? ok(`effort for ${model}: ${level} from the next request`) : saved;
  })(ctx);
}

async function fastCommand(args: string[], ctx: CommandContext): Promise<Result<string>> {
  const arg = one(args);
  if (arg !== "on" && arg !== "off") return fail("usage: fast on|off");
  return withConversation(async conversation => {
    const model = await modelOf(conversation);
    await learnModel(model);
    const saved = await setFast(conversation, arg === "on");
    return saved.ok ? ok(`fast for ${model}: ${arg} from the next request`) : saved;
  })(ctx);
}

async function accountsCommand(args: string[], ctx: CommandContext): Promise<Result<string>> {
  const id = one(args);
  if (id.length === 0) return fail("usage: accounts <account>");
  return withConversation(async conversation => {
    const found = (await accounts()).find(a => a.ok && a.id === id);
    if (found === undefined) return fail(`no account ${id}; accounts lists them`);
    const used = await useAccount(conversation, found);
    return used.ok ? ok(used.data.note) : used;
  })(ctx);
}

async function loginCommand(args: string[], ctx: CommandContext): Promise<Result<string>> {
  const request = parseLogin(args);
  if (!request.ok) return request;
  const { provider, profile } = request.data;
  const id = `${provider}:${profile}`;
  const signed = await signIn(request.data, { write: ctx.write, openBrowser: ctx.openBrowser, ...(ctx.signal === null ? {} : { signal: ctx.signal }) });
  if (!signed.ok) return signed;
  const conversation = await ctx.conversation();
  if (!conversation.ok) {
    await saveConfig(provider === "anthropic" ? { account: profile === "default" ? "" : profile } : { openaiAccount: profile === "default" ? "" : profile });
    return ok(`${id} signed in`);
  }
  const account: Account | undefined = (await accounts()).find(a => a.provider === provider && a.profile === profile);
  if (account === undefined || !account.ok) return fail(`signed in to ${id}, but it does not show as signed in yet`);
  const used = await useAccount(conversation.data, account);
  return used.ok ? ok(`signed in to ${id}; ${used.data.note}`) : used;
}

const pick = (choices: (ctx: CommandContext) => Promise<Result<Choices>>): Ask => ({ kind: "pick", choices });

export const COMMANDS: CoreCommand[] = [
  { name: "model", args: "[model]", description: "switch the chat's model", scoped: true, run: setModelCommand,
    ask: pick(withConversation(async conversation => {
      const offered = await modelChoices(await modelOf(conversation));
      return offered.ok ? ok({ title: "switch model   (/accounts for another provider)", choices: offered.data }) : offered;
    })) },
  { name: "effort", args: "[level|default]", description: "set the reasoning effort for the chat's model", scoped: true, run: effortCommand,
    ask: pick(withConversation(async conversation => {
      const model = await modelOf(conversation);
      await learnModel(model);
      return ok({ title: `effort for ${model}   (/effort <level|default> sets directly)`, choices: effortChoices(model, conversation.effort) });
    })) },
  { name: "fast", args: "[on|off]", description: "turn fast mode on or off for the chat's model", scoped: true, run: fastCommand,
    ask: pick(withConversation(async conversation => {
      const model = await modelOf(conversation);
      await learnModel(model);
      return ok({ title: `fast mode for ${model}   (/fast on|off sets directly)`, choices: fastChoices(conversation.fast).map(c => ({ ...c, value: c.value ? "on" : "off" })) });
    })) },
  { name: "accounts", args: "[account]", description: "use a signed-in account for the chat (its provider's account is global); without one, list them", scoped: true, run: accountsCommand,
    ask: pick(async ctx => {
      const conversation = await ctx.conversation();
      const listed = await accountChoices(conversation.ok ? await modelOf(conversation.data) : (await loadConfig()).model);
      if (listed.length === 0) return fail("no accounts; login signs in");
      return ok({ title: "accounts: enter uses one for this chat", choices: listed.map(c => ({ ...c, value: c.value.id })) });
    }) },
  { name: "login", args: "anthropic|openai [profile] [--import]", description: "sign in to a provider in the browser (--import takes Claude Code's or Codex's sign-in) and use it for the chat", scoped: true, run: loginCommand,
    ask: pick(async () => ok({ title: "sign in   (/login <provider> [profile] [--import] sets directly)", choices: [
      { value: "anthropic", label: "anthropic ", detail: "claude subscription", current: false },
      { value: "openai", label: "openai    ", detail: "chatgpt / codex subscription", current: false },
    ] })) },
  { name: "mux", args: "[runner]", description: "choose where new agents start (plain or a runner plugin); running ones stay", scoped: true,
    run: async (args, ctx) => withConversation(async conversation => {
      const name = one(args);
      if (name.length === 0) return fail("usage: mux <runner>");
      const chosen = await chooseRunner(conversation.id, name);
      return chosen.ok ? ok(`new agents start in ${chosen.data}; running ones stay where they are`) : chosen;
    })(ctx),
    ask: pick(withConversation(async conversation => {
      const names = await runnerNames(conversation.id);
      const current = (await loadConfig()).runner;
      return ok({ title: "runner for new agents", choices: names.map(name => ({ value: name, label: name, detail: "", current: name === current })) });
    })) },
  { name: "compact", args: "", description: "compact the chat's context now", scoped: true, ask: null,
    run: async (_args, ctx) => withConversation(async (conversation, c) => {
      await compactNow(conversation.id);
      const started = await c.ensureDaemon(conversation.id);
      return started.ok ? ok("compacting…") : fail(`daemon: ${started.error}`);
    })(ctx) },
  { name: "rename", args: "\"name\"", description: "rename the chat (and its bubble while that still has the old name)", scoped: true,
    ask: { kind: "input", prompt: "rename to ", initial: async ctx => { const c = await ctx.conversation(); return c.ok ? c.data.name : ""; } },
    run: async (args, ctx) => withConversation(async conversation => {
      const renamed = await renameConversation(conversation.id, args.join(" "));
      if (!renamed.ok) return renamed;
      return ok(`renamed to ${renamed.data.conversation.name}${renamed.data.bubble === null ? "" : " (its bubble too)"}`);
    })(ctx) },
  { name: "stop", args: "", description: "stop the chat's daemon", scoped: true, ask: null,
    run: async (_args, ctx) => withConversation(async conversation => { await stopDaemon(conversation.id); return ok("daemon stopped"); })(ctx) },
  { name: "trust", args: "[folder]", description: "trust a folder again: its instructions, skills and plugins load (restart agents to pick them up)", scoped: false, ask: null,
    run: async (args, ctx) => { const folder = args[0] ?? ctx.directory; await setTrust(folder, true); return ok(`trusted ${folder}`); } },
  { name: "untrust", args: "[folder]", description: "keep a folder's instructions, skills and plugins off", scoped: false, ask: null,
    run: async (args, ctx) => { const folder = args[0] ?? ctx.directory; await setTrust(folder, false); return ok(`untrusted ${folder}`); } },
  { name: "plugins", args: "", description: "open the Plugins page (CLI: orca2 plugin list)", scoped: false, ask: null, run: null },
  { name: "close", args: "", description: "close the chat's tab; the chat stays", scoped: false, ask: null, run: null },
  { name: "help", args: "", description: "show the keys and commands (CLI: orca2 help)", scoped: false, ask: null, run: null },
  { name: "quit", args: "", description: "quit the TUI (also /exit)", scoped: false, ask: null, run: null },
];

export const command = (name: string): CoreCommand | null => COMMANDS.find(c => c.name === name) ?? null;

export function commandUsage(c: CoreCommand): string {
  return `orca2 ${c.name}${c.args.length > 0 ? ` ${c.args}` : ""}${c.scoped ? " [--conversation id]" : ""}`;
}

export type PluginCommand = { plugin: string; name: string; description: string };

export async function pluginCommands(conversation: string): Promise<PluginCommand[]> {
  const { uis } = await enabledUis(conversation);
  const seen = new Set(COMMANDS.map(c => c.name));
  const out: PluginCommand[] = [];
  for (const { name, ui } of uis) for (const c of ui.commands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ plugin: name, name: c.name, description: c.description });
  }
  return out;
}
