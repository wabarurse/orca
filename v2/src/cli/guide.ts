import { pluginSlashCommands, SLASH_COMMANDS, type PluginSlashCommand } from "../core/slash-commands";
import { MCP_USAGE } from "./mcp";
import { PLUGIN_USAGE } from "./plugin";

export const USAGE = `orca2 [start] [folder]            open the TUI for a folder's conversation
  orca2 -p "task" [--json] [--model m] [--cwd folder] [--conversation id] [--bundle name] [--yes]
  orca2 msg "text" [--conversation id]  send input to a conversation's orchestrator
  orca2 stop [--conversation id]        stop its daemon
  orca2 list                            conversations
  orca2 spans [conversation] [--json]   where the wall-clock time went
  orca2 delete --conversation id        stop its agents and remove it
  orca2 bubbles                         bubbles and the folder each belongs to
  orca2 bubble <name|id> --dir <folder>  point a bubble at a folder (chats there are offered it)
  orca2 rename "name" [--conversation id]  rename a conversation (and its bubble while that still has the old name)
  orca2 login anthropic|openai [profile] [--import]
  orca2 accounts
  orca2 untrust [folder] | orca2 trust [folder]     keep a folder's instructions, skills and plugins off (trust undoes it)
  orca2 mcp [test|login|logout] [name]
  ${PLUGIN_USAGE}
  orca2 clean [--preview] [--yes] [--json]  delete leftover storage after asking; --preview lists without deleting, --yes skips the question
  orca2 pull                            update ~/.orca2/.runtime/app from origin/main and reinstall ~/.local/bin/orca2
  orca2 skill                           print the guide for agents using this CLI
  orca2 version`;

const GUIDANCE = `How to use it as an agent:

- You run inside a conversation: $ORCA_CONVERSATION is its id, $ORCA_DATA its plugin data. Commands that take
  --conversation default to the current folder's conversation and create one when the folder has none (a worktree
  has none), so always pass --conversation "$ORCA_CONVERSATION" when you mean your own.
- Scopes: plugin commands from an agent default to its conversation's bubble. Use --bubble <id> for another bubble and
  --global only when the user asks for a global change.
- --yes approves a plugin's exact content without asking. Use it only for an install or update the user requested;
  group the plugins of one request in one enable. Verify every change with orca2 plugin list --json (or show --json).
- Read-only, safe any time: help, skill, version, list, bubbles, accounts, spans, plugin list/show/check/help,
  plugin config without --set/--unset, mcp, mcp test, clean --preview.
- Change state; only when asked: msg, rename, bubble, trust/untrust, plugin enable/disable/inherit/new,
  plugin config --set/--unset, mcp login/logout.
- Never without an explicit request, and never on your own conversation: delete, stop, clean (without --preview),
  pull, login. They end agents, remove data, replace the binary or open a browser sign-in.
- Do not start the TUI (orca2 or orca2 start): it needs the user's terminal. orca2 -p runs a headless task and may
  spend model usage; use it only when asked.
- Writing a plugin: load the orca-plugin skill.`;

function slashLines(plugins: PluginSlashCommand[] | null): string {
  const core = SLASH_COMMANDS.map(c => `  ${c.usage}: ${c.description}${c.cli === null ? "" : ` (CLI: ${c.cli})`}`);
  const added = plugins === null ? ["  (plugins' commands: run orca2 skill inside a conversation, with $ORCA_CONVERSATION set)"]
    : plugins.map(c => `  /${c.name}: ${c.description} (plugin ${c.plugin})`);
  return [...core, ...added].join("\n");
}

export async function agentGuide(conversation: string | null): Promise<string> {
  const plugins = conversation === null ? null : await pluginSlashCommands(conversation);
  return `orca2 for agents

Commands (the same text as orca2 help, from this installed binary):
  ${USAGE}

orca2 mcp in detail:
  ${MCP_USAGE}

TUI slash commands: user-only. You cannot type them; tell the user to type one in their orca2 chat, or use the CLI
equivalent when there is one:
${slashLines(plugins)}

${GUIDANCE}
`;
}
