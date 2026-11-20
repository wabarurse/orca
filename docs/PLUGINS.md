# Core loop and plugins

A plan, not current behavior. Orca keeps a small core — the agent loop, the orchestrator and its workers, rolling
compaction and bubbles — and everything else becomes a plugin that adds tools, prompt text, skills, storage and TUI
parts. Agents are bundles: a prompt plus the plugins they use. Modelled on DeepSeek Harness's plugins and agent
presets, without its dependency injection, middleware events, YAML layers or hot reload.

## The core

- The agent loop, providers and accounts, transcripts, rolling compaction.
- The orchestrator daemon and its workers and reviewers; the inbox between them.
- Bubbles: shared memory, notebook and behavior.
- Pasting images, MCP, web search, skills.
- The TUI shell: chat, header, composer, the work page frame, the Agents tab. It draws what plugins register.

### Core tools (12, down from 18)

| Tool | Replaces | Does |
|---|---|---|
| `bash`, `read`, `write`, `edit` | same | files and commands; the orchestrator keeps `read` only (it used write/edit 11 times in 264 conversations) |
| `subagent` | `spawn`, `runtime` | start a bundle, list subagents, their status and sibling conversations |
| `inbox` | `inbox` without its question actions | messages between agents and to the user |
| `memory` | `memory`, `history`, `task search_history/read_history` | the bubble's memory tree; `search` also covers archived messages and labels each match |
| `notebook` | `notebook`, `context result` | large docs and results, read on demand |
| `behavior` | `remember` | the user's preferences (user-wide and per bubble); explicit ones quote a real message |
| `skill`, `web_search`, `mcp` | same | unchanged |

`context` (the working brief) is dropped once rolling memory is shown to keep what it holds; `runtime usage` was
never called and goes.

## Plugins

A plugin is a folder:

```
plugins/questions/
  index.ts        // every process: tools, prompt, skills, storage
  ui.ts           // the TUI only: tabs, counts, commands, tool lines, folds
  background.ts   // the daemon only: watchers, memory section, runner
  skills/
```

```ts
interface Plugin {
  name: string; description: string;
  tools: { tool: Tool; roles: Role[] }[];
  prompt: Partial<Record<Role, string>>;       // added only by bundles that use the plugin
  skills: string[];
  storage: { scope: "conversation" | "bubble" | "global"; about: string }[];
  ui: string | null;                           // "./ui.ts"
  background: string | null;                   // "./background.ts"
}
interface PluginUi { tabs: Tab[]; counts: Count[]; commands: Command[]; toolLines: Record<string, ToolLine>; folds: Record<string, Fold> }
interface PluginBackground { watchers: Watcher[]; memory: MemorySection | null; runner: Runner | null; stop: Hook | null; remove: Hook | null }
interface Bundle { name: string; role: Role; prompt: string; plugins: string[] }
```

- **UI is data.** A plugin returns rows, details, counts and fold items; orca draws them, so every plugin looks
  native and frames stay fast. Tab actions get a host with `note`, `confirm`, `input` and `pick`.
- **Storage** is `$ORCA_DATA/<plugin>` for the conversation, `$ORCA_DATA/bubble/<plugin>` for its bubble and
  `$ORCA_DATA/global/<plugin>` for all (PR #298). The model is told once, in fixed text; reads are open, changes go
  through the plugin's tools. Deleting a conversation or bubble deletes its folders; `stop` and `remove` cover
  anything a plugin keeps elsewhere.
- **Enablement** follows bubbles: defaults in `config.toml` (`plugins = [...]`), plus each bubble's `on` and `off`
  lists. Agents read the set when they start, so tools and prompt stay fixed for a run and the prompt cache holds;
  changes apply to the next agent (the orchestrator's next turn). `/plugins` lists and toggles them.
- **Loading**: built-in plugins in `src/plugins/`, user plugins in `~/.orca/plugins/<name>/`. A user plugin runs
  with the user's permissions, like a skill running bash.
- **Bundles**: `orchestrator`, `worker` and `reviewer` are built in; plugins and users can add more, and
  `subagent spawn` takes a bundle name.

### The plugins

| Plugin | Agent side | TUI side | Background |
|---|---|---|---|
| questions | `ask` tool, prompt | Questions tab (Ctrl+Q), count, `+ questions` fold, answer input | — |
| tasks | `task` tool | Tasks tab (Ctrl+T), count, fold | Tasks memory section |
| pr-watch | — | PR rows in Processes | merge watcher, `[pr-blocked]` notices |
| processes | `process` tool | Processes tab, count | — |
| images | images delivered by tools | Images tab, inline images | — |
| sandbox | `sandbox` tool | — | — |
| tmux | — | — | runner |
| rex | Rex skill | `/mux`, Rex rows in Processes | runner |

`/mux` picks which enabled runner starts new agents; liveness and stop ask every enabled runner.

## Order of work

1. `$ORCA_DATA` folders and links (#298).
2. The plugin seam: loader, `index.ts` parts, bundles, enablement per bubble; today's tools as one built-in plugin; a
   small example user plugin.
3. Core tool merges: `subagent`, `memory` search, `behavior`; drop `context` after checking rolling memory.
4. UI and background slots; tmux and rex as the first runner plugins (#294).
5. questions, then processes, sandbox, images.
6. tasks and pr-watch last: they reach into spawn, compaction's Tasks section and the merge watcher, and test whether
   the memory-section and watcher slots are enough.

Each step is its own PR. Existing homes need one logged move per plugin whose files change place (questions from
`projects/<id>/questions/` to its data folder).
