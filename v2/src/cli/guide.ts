import { COMMANDS, commandUsage, pluginCommands, type PluginCommand } from "../core/commands";
import { MCP_USAGE } from "./mcp";
import { PLUGIN_USAGE } from "./plugin";

const line = (usage: string, about: string): string => `${usage.padEnd(37)} ${about}`;
const CHAT_COMMANDS = COMMANDS.filter(c => c.run !== null).map(c => line(commandUsage(c), c.description)).join("\n  ");

export const USAGE = `orca2 [start] [folder]            open the TUI for a folder's conversation
  orca2 -p "task" [--json] [--model m] [--cwd folder] [--conversation id] [--bundle name] [--yes]
  orca2 msg "text" [--conversation id]  send input to a conversation's orchestrator
  orca2 list                            conversations
  orca2 spans [conversation] [--json]   where the wall-clock time went
  orca2 delete --conversation id        stop its agents and remove it
  orca2 bubbles                         bubbles and each one's home folder
  orca2 bubble <name|id> --dir <folder>  set a bubble's home folder (chats there see it first)
  ${CHAT_COMMANDS}
  orca2 mcp [test|login|logout] [name]
  ${PLUGIN_USAGE}
  orca2 clean [--preview] [--yes] [--json]  delete leftover storage after asking; --preview lists without deleting, --yes skips the question
  orca2 pull                            update ~/.orca2/.runtime/app from origin/main and reinstall ~/.local/bin/orca2
  orca2 skill                           print the guide for agents using this CLI
  orca2 version
  Each command above from model to untrust is also a slash command in the TUI (/model, ...) running the same code;
  without its argument the TUI offers a picker and the CLI lists the choices. --conversation defaults to
  $ORCA_CONVERSATION inside an agent, else the current folder's conversation.`;

const GUIDANCE = `How to use it as an agent:

- You run inside a conversation: $ORCA_CONVERSATION is its id, $ORCA_DATA its plugin data. Commands that take
  --conversation default to it, so model, effort, fast, compact, rename and stop act on your own chat (the one the
  user is looking at). Pass --conversation id for another one.
- Scopes: plugin commands from an agent default to its conversation's bubble. Use --bubble <id> for another bubble and
  --global only when the user asks for a global change.
- --yes approves a plugin's exact content without asking. Use it only for an install or update the user requested;
  group the plugins of one request in one enable. Verify every change with orca2 plugin list --json (or show --json).
- After changing an installed plugin, run orca2 plugin update <name> [--from <folder>] --yes, never enable (enable also
  turns it on). New agents load the new version at once; a running chat keeps what it loaded until it is restarted:
  orca2 stop --conversation id (or /stop), then the user reopens orca2.
- Read-only, safe any time: help, skill, version, list, bubbles, spans, plugin list/show/check/help, plugin config
  without --set/--unset, mcp, mcp test, clean --preview, and model, effort, fast, accounts, mux or notifications
  without an argument (they list the choices, the current one marked *).
- Change state; only when the user asks: model/effort/fast/accounts/mux/notifications with an argument, compact, cancel,
  clear-chat, msg, rename, bubble, trust/untrust, plugin enable/disable/inherit/update/new, plugin config --set/--unset,
  mcp login/logout. A running TUI shows a changed model, effort or account within a few seconds.
- Never without an explicit request, and never on your own conversation: delete, stop, kill, clean (without --preview),
  pull, login. They end agents, remove data, replace the binary or open a browser sign-in.
- Do not start the TUI (orca2 or orca2 start): it needs the user's terminal. orca2 -p runs a headless task and may
  spend model usage; use it only when asked.
- Writing a plugin: load the orca-plugin skill.`;

function tuiLines(plugins: PluginCommand[] | null): string {
  const only = COMMANDS.filter(c => c.run === null).map(c => `  /${c.name}: ${c.description}`);
  const added = plugins === null ? ["  (plugins' slash commands are listed when orca2 skill runs inside a conversation)"]
    : plugins.map(c => `  /${c.name}: ${c.description} (plugin ${c.plugin}; TUI-only)`);
  return [...only, ...added].join("\n");
}

export async function agentGuide(conversation: string | null): Promise<string> {
  const plugins = conversation === null ? null : await pluginCommands(conversation);
  return `orca2 for agents

Commands (the same text as orca2 help, from this installed binary):
  ${USAGE}

orca2 mcp in detail:
  ${MCP_USAGE}

TUI-only slash commands (they only change what the user's screen shows; ask the user to type one if needed):
${tuiLines(plugins)}

${GUIDANCE}
`;
}
