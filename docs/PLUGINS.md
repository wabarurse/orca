# Core loop and plugins

A plan, not current behavior. A small core (agent loop, orchestrator and workers, rolling compaction, bubbles); the
rest are plugins adding tools, prompt, skills, storage and TUI parts. Agents are bundles: a prompt plus plugins.
Modelled on DeepSeek Harness's plugins and presets, without dependency injection, middleware events, YAML layers or
hot reload.

## v2

Built as a new application beside v1, in `v2/` at the repository root: its own `package.json`, `tsconfig`, tests,
binary (`orca2`) and home (`~/.orca2`, `ORCA2_HOME` in tests), sign-in included. It imports nothing from v1: what it
needs from v1 (providers, OAuth, the OpenTUI view, transcripts, compaction, bubbles) is copied in and owned there. v1
keeps running unchanged until v2 replaces it.

```
v2/src/
  config/   paths, home, config.toml
  api/      providers, accounts, OAuth
  core/     agent loop, daemon, inbox, transcripts, compaction, bubbles, plugin loader, bundles, core tools
  tui/      OpenTUI shell: chat, header, composer, work page frame, the slots plugins fill
  cli/      orca2 start | agent | plugin …
  plugins/  built-in plugins, one folder each
skills/orca-plugin/   how to write a plugin, for orca's own agents
```

Orca builds its own plugins. The `orca-plugin` skill ships with the core and teaches an agent to create one: the
folder layout, `definePlugin`, each slot with an example, `$ORCA_DATA` storage, enablement, and testing. The dev loop
is commands an agent can run: `orca2 plugin new <name>` (folder from a template), `orca2 plugin check <name>`
(loads and type-checks it against a temporary home, runs its tests), `orca2 plugin enable <name> [--bubble]`.
Workers build plugins in their worktree like any code. A plugin runs with the user's permissions, so enabling one
orca wrote always asks the user first, showing what it adds (tools, tabs, storage); it never enables itself.
Built-in plugins land in `v2/src/plugins/` through a reviewed PR.

## Core

Agent loop, providers and accounts, transcripts, rolling compaction; the orchestrator daemon, workers, reviewers and
the inbox; a plain runner that starts agents as supervised child processes with log files (tmux and rex are plugins
that add windows you can watch); bubbles (memory, notebook, behavior); pasting images, MCP, web search, skills; the TUI shell (chat,
header, composer, work page frame, Agents tab), which draws what plugins register.

**Tools: 12, down from 18**

| Tool | Replaces | Does |
|---|---|---|
| `bash`, `read`, `write`, `edit` | same | files and commands; orchestrator keeps `read` only (write/edit: 11 calls in 264 conversations) |
| `subagent` | `spawn`, `runtime` | start a bundle; list subagents, their status, sibling conversations |
| `inbox` | `inbox` minus question actions | messages between agents and to the user |
| `memory` | `memory`, `history`, `task search_history/read_history` | the bubble's memory tree; `search` also covers archived messages, labelled |
| `notebook` | `notebook`, `context result` | large docs and results, read on demand |
| `behavior` | `remember` | user preferences, user-wide and per bubble; explicit ones quote a real message |
| `skill`, `web_search`, `mcp` | same | unchanged |

`context` (the working brief) goes once rolling memory is shown to keep what it holds; `runtime usage` was never
called.

**Also in the core, from pi** (research/pi): headless modes (`orca2 -p "task"` prints the answer, `--json` streams
every event, needed for verification); loop hooks for plugins (before a tool call: block, change input or ask;
after: change the result; before each request: change context; on user input), including replacing a built-in tool;
steering versus follow-up input (taken after the current reply, or once the work is done; Esc returns queued input to
the composer); and project trust (ask before loading a repository's instructions, skills or plugins). Later or as
plugins: codemode, installing plugins from npm or git, session branching, providers and prompt templates from
plugins, remote execution.

## Plugins

```
plugins/questions/
  index.ts        every process: tools, prompt, skills, storage
  ui.ts           TUI only: tabs, counts, commands, tool lines, folds
  background.ts   daemon only: watchers, memory section, runner
  skills/
```

```ts
interface Plugin {
  name: string; description: string;
  tools: { tool: Tool; roles: Role[] }[];
  prompt: Partial<Record<Role, string>>;       // added only by bundles using the plugin
  skills: string[];
  storage: { scope: "conversation" | "bubble" | "global"; about: string }[];
  ui: string | null;                           // "./ui.ts"
  background: string | null;                   // "./background.ts"
}
interface PluginUi { tabs: Tab[]; counts: Count[]; commands: Command[]; toolLines: Record<string, ToolLine>; folds: Record<string, Fold> }
interface PluginBackground { watchers: Watcher[]; memory: MemorySection | null; runner: Runner | null; stop: Hook | null; remove: Hook | null }
interface PluginHooks { beforeTool: BeforeTool[]; afterTool: AfterTool[]; beforeRequest: BeforeRequest[]; onInput: OnInput[] }  // in index.ts
interface Bundle { name: string; role: Role; prompt: string; plugins: string[] }
```

- **UI is data:** plugins return rows, details, counts and fold items; orca draws them (native look, fast frames).
  Tab actions get a host with `note`, `confirm`, `input`, `pick`.
- **Storage:** `$ORCA_DATA/<plugin>` (conversation), `$ORCA_DATA/bubble/<plugin>`, `$ORCA_DATA/global/<plugin>`
  (#298). The model is told once, in fixed text; reads are open, changes go through the plugin's tools. Deleting a
  conversation or bubble deletes its folders; `stop` and `remove` cover anything kept elsewhere.
- **Enablement:** defaults in `config.toml` (`plugins = [...]`) plus each bubble's `on`/`off` lists, read when an
  agent starts (tools and prompt fixed per run, prompt cache holds; changes apply to the next agent or orchestrator
  turn). `/plugins` lists and toggles.
- **Loading:** built-in in `src/plugins/`, user plugins in `~/.orca/plugins/<name>/`, running with the user's
  permissions like a skill running bash.
- **Bundles:** `orchestrator`, `worker`, `reviewer` built in; plugins and users add more; `subagent spawn` takes a
  bundle name.

| Plugin | Agent | TUI | Background |
|---|---|---|---|
| questions | `ask` tool, prompt | Questions tab (Ctrl+Q), count, `+ questions` fold, answer input | — |
| tasks | `task` tool | Tasks tab (Ctrl+T), count, fold | Tasks memory section |
| pr-watch | — | PR rows in Processes | merge watcher, `[pr-blocked]` notices |
| processes | `process` tool | Processes tab, count | — |
| images | images from tools | Images tab, inline images | — |
| sandbox | `sandbox` tool | — | — |
| tmux | — | — | runner |
| rex | Rex skill | `/mux`, Rex rows in Processes | runner |

`/mux` picks which enabled runner starts new agents (the core's plain runner when none is enabled); liveness and
stop ask every runner.

## Order of work: a two-PR stack in `v2/`

1. **Core harness:** the v2 app with the core above, its 12 tools and pi's four additions, the plugin loader, hooks,
   bundles, per-bubble enablement, `$ORCA_DATA` (as in #298), the UI and background slots, the `orca-plugin` skill,
   the plugin dev loop and enable approval, and an example plugin. Runs a conversation end to end on its own, then is
   verified against Claude Code and Codex before the second PR merges.
2. **Plugins, stacked on 1:** tmux and rex (#294) as runners, questions, processes, sandbox, images, then tasks and
   pr-watch (they reach into spawn, compaction's Tasks section and the merge watcher, testing whether the
   memory-section and watcher slots suffice). Built with the `orca-plugin` skill; what goes wrong goes back into it.
   After this, orca builds further plugins itself.

v2 starts with an empty home, so nothing moves; v1 homes stay as they are.

## Verification

Measured on v1 first (the baseline), then on v2 after each PR of the stack, same tasks and same model per provider, for
four arms: v1, v2, Claude Code (Claude models), Codex (OpenAI models).

- **Tasks** (from `research/bubbles-eval/`, comparable with earlier rounds): the coding replays `flag` (#26022 from
  `7b0500e6`) and `names` (#25739 from `eba14835`), scored against `checklists-round2.md` (written before any result
  is read); the bubble quiz (`questions-session.md`, `questions-general.md`), blank and with the imported bubble,
  scored against `quiz-answers/`.
- **Metrics** (`orca-metrics.py`, `cc-metrics.py`, plus one for Codex): cost from input, cached and output tokens per
  agent and purpose (agent, compaction, rolling summary), priced per provider; wall clock from first user message to
  final answer, plus model time; checklist items met and quiz answers correct; tool calls by tool (no `context`,
  `history` or `runtime`).
- **Pass:** v2 within 10% of v1 on cost and time, no fewer checklist items or quiz answers, and within 10% of
  the better of Claude Code and Codex on cost and time per task. A failure blocks the next step until explained or
  fixed. Results go in `research/` with run ids.
