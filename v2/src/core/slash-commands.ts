import { readConversation } from "./conversations";
import { enabledUis } from "./plugins/uis";

export type SlashCommand = { name: string; usage: string; description: string; cli: string | null };

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "rename", usage: "/rename [name]", description: "rename this chat (and its bubble while that still has the old name)", cli: "orca2 rename \"name\" --conversation id" },
  { name: "close", usage: "/close", description: "close this chat's tab (the chat stays)", cli: null },
  { name: "compact", usage: "/compact", description: "compact this chat's context now", cli: null },
  { name: "login", usage: "/login [anthropic|openai] [profile] [--import]", description: "sign in to a provider account", cli: "orca2 login anthropic|openai [profile] [--import]" },
  { name: "model", usage: "/model [model]", description: "switch this chat's model", cli: null },
  { name: "effort", usage: "/effort [level|default]", description: "set the reasoning effort for this chat's model", cli: null },
  { name: "fast", usage: "/fast [on|off]", description: "turn fast mode on or off for this chat's model", cli: null },
  { name: "accounts", usage: "/accounts", description: "pick the account this chat uses", cli: "orca2 accounts (lists them only)" },
  { name: "mux", usage: "/mux [runner]", description: "choose where new agents start (tmux, Rex, ...)", cli: null },
  { name: "plugins", usage: "/plugins", description: "open the Plugins page", cli: "orca2 plugin list" },
  { name: "trust", usage: "/trust", description: "trust this chat's folder again (its instructions, skills and plugins load)", cli: "orca2 trust [folder]" },
  { name: "stop", usage: "/stop", description: "stop this chat's daemon", cli: "orca2 stop --conversation id" },
  { name: "help", usage: "/help", description: "show the keys and commands", cli: "orca2 help" },
  { name: "quit", usage: "/quit (or /exit)", description: "quit the TUI", cli: null },
];

export type PluginSlashCommand = { plugin: string; name: string; description: string };

export async function pluginSlashCommands(conversation: string): Promise<PluginSlashCommand[]> {
  if (await readConversation(conversation) === null) return [];
  const { uis } = await enabledUis(conversation);
  const seen = new Set(SLASH_COMMANDS.map(c => c.name));
  const out: PluginSlashCommand[] = [];
  for (const { name, ui } of uis) for (const command of ui.commands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    out.push({ plugin: name, name: command.name, description: command.description });
  }
  return out;
}
