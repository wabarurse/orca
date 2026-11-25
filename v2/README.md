# orca2

orca v2: a small core harness plus plugins. It lives beside v1 and shares nothing with it at runtime: its own
package, tests, binary (`orca2`), home (`~/.orca2`, `ORCA2_HOME` in tests) and sign-in. The design is
`docs/PLUGINS.md` on branch `docs/plugins-plan`.

Install (a dedicated clone in `~/.orca2/.runtime/app`, the compiled binary in `~/.local/bin/orca2`), then update and
tidy up:

```bash
curl -fsSL https://raw.githubusercontent.com/wabarurse/orca/main/v2/install.sh | sh
orca2 pull                 # fast-forward the clone to origin/main, rebuild, reinstall, hand running daemons over
orca2 clean --preview      # list leftover storage; orca2 clean removes it after asking (--yes skips, --json for scripts)
```

From a checkout instead:

```bash
cd v2 && bun install
bun run install:local                        # build dist/orca2 and install it to ~/.local/bin/orca2
bun src/cli/main.ts login anthropic          # or openai; --import copies an existing Claude Code / Codex login
bun src/cli/main.ts                          # TUI for the current folder's conversation
bun src/cli/main.ts -p "fix the failing test" --json
bun run check && bun run lint && bun test
```

## What the core is

- **One agent loop** (`src/core/loop/agent.ts`) for the orchestrator, workers, reviewers and plugin bundles: inbox →
  model → tools (through plugin hooks) → inbox, until the model stops and nothing new arrived.
- **Input**: Enter queues input as *steer* (read after the current tool batch); Tab while busy queues it as
  *follow-up* (read once the work is done); Esc takes the newest queued message back into the composer.
- **The orchestrator daemon** (`src/core/daemon/`): one process per conversation runs every orchestrator turn,
  the plugins' background watchers and an exit watchdog. TUIs and `orca2 msg` only read files and write the inbox.
- **The plain runner** (`src/core/runner/`): agents are detached child processes with a log file each and a run
  record (`runs/<agent>.json`). Workers in a Git checkout get a worktree under `~/.orca2/worktrees/`.
  Runner plugins (tmux, rex) add windows you can watch; every runner starts the agent through the core's launch
  command (`launchCommand`: the environment in a private self-deleting file, output teed to the log). `/mux` in the
  TUI lists plain and every enabled runner plugin and saves the choice as `runner` in config.toml.
- **Memory**: workers compact in the foreground at 90% of the window; the orchestrator keeps background rolling
  memory from 25% (small model, ~50k verbatim tail, the newest exchange always whole). Everything compaction
  replaces is archived in `archive.sqlite` first, and `memory search` finds it.
- **Bubbles**: conversations that share memory nodes, notebook pages, behavior lines and plugin switches. A bubble's
  folder is its home, not a limit: the bubble picker (new chat, Ctrl+N, the Bubbles tab) lists the bubbles whose
  folder holds the chat's folder first, then every other bubble labelled with its folder, and any of them can be joined.
- **Headless**: `orca2 -p "task"` runs the orchestrator in-process until its subagents finish and prints the answer;
  `--json` prints every event (start, input, text, tool_start, tool_end, notice, usage, span_start, span_end, end) as JSON lines.
- **Spans**: every model request, tool call, wait (for a worker, for input), worker launch, blocking compaction and
  request preparation is appended to the conversation's `spans.jsonl` (never model-visible); the TUI's activity line
  names the open one with its elapsed time, and `orca2 spans [conversation] [--json]` breaks the wall time down.
- **Project trust**: every folder is trusted, with no question asked. `orca2 untrust [folder]` (or `/trust` and
  `orca2 trust` to undo it) keeps a folder's AGENTS.md/CLAUDE.md, skills and `.orca2/plugins/` out of its agents.

### The 12 tools

`bash`, `read`, `write`, `edit` (the orchestrator gets `read` only), `subagent` (spawn a bundle on a branch, list,
stop, siblings), `inbox` (messages only), `memory` (the bubble's tree; `search` also covers archived messages),
`notebook`, `behavior` (user-wide and per-bubble preferences; explicit lines must trace to a real user message),
`skill`, `web_search`, `mcp`.

v1's `context` tool (the working brief) is gone. What the brief held is kept elsewhere: the goal, decisions and
usable results (with their locations) are what the rolling summary is asked to keep first; the user's latest
messages stay in the verbatim tail (`rolling.test.ts` checks both); sections a plugin keeps (a task list) are
rendered verbatim beside the summary. `runtime` became `subagent list`; `history` and `task search_history` became
`memory search`.

## Plugins

A plugin is a folder with `index.ts` (tools, prompt lines, skills, storage, hooks, bundles), optionally `ui.ts`
(tabs, counts, commands, tool lines, folds; drawn by orca) and `background.ts` (watchers, a memory section, a
runner, stop/remove hooks). Types: `src/core/plugins/types.ts`; the full guide is the `orca-plugin` skill
(`skills/orca-plugin/SKILL.md`, shipped in the binary). `src/test/plugins/example/` uses every slot (a test fixture,
not shipped).

- **Where**: orca2 ships no plugins. User plugins live in `~/.orca2/plugins/`, outside this repository; a folder's
  own in `.orca2/plugins/` (unless the folder is untrusted).
- **Imports**: a plugin imports `orca2/plugin` (the types and helpers such as `definePlugin`, `writeAtomic`, `exec`,
  `z`) and, in its tests, `orca2/plugin/testing`. orca2 provides both when it loads a plugin, the installed binary
  included (`src/core/plugins/modules.ts`); for `bun test` and an editor, the plugins folder carries a `bunfig.toml`
  preloading `src/core/plugins/preload.ts` and a `tsconfig.json` mapping both paths to an orca2 checkout.
- **Enablement**: `plugins = [...]` in `~/.orca2/config.toml` is the default for every bubble (without the line: none);
  each bubble then has its own on/off lists (Ctrl+P → `t`
  in the TUI, or `orca2 plugin enable|disable <name> --bubble`). The footer's `N plugins` and the agent's "Plugins on in
  this bubble" list are the same set. Read when an agent starts, so tools and prompt stay fixed for a run.
To enable several installed plugins together, run `orca2 plugin enable images sandbox tmux rex`. It asks once for the versions that need approval. Use `orca2 plugin show <name>` to inspect details.

- **Approval**: a user plugin loads only while its exact content (a hash of its files) is approved. `orca2 plugin
  enable` asks at a terminal, or accepts `--yes` in scripts and agents. Inside an agent it targets that conversation’s bubble, including from worker worktrees. Use `--global` to change the default, `inherit` to remove a bubble override, and `list --json` to verify the effective setting.
- **Settings**: `orca2 plugin config <name> [--set <key> <JSON> | --unset <key>]` reads effective settings or changes a documented plugin option. Bubble values override global ones.
- **Storage**: `$ORCA_DATA/<plugin>/` (conversation), `$ORCA_DATA/bubble/<plugin>/`, `$ORCA_DATA/global/<plugin>/`.
  `bubble/` links to the bubble's `data/` (made or moved when the conversation gets or joins a bubble) and `global/`
  to `~/.orca2/global/`; both names are reserved, and a real folder under either is reported, never replaced.
- **Hooks**: `beforeTool` (run with changed input, block, or ask the user), `afterTool`, `beforeRequest`, `onInput`,
  and replacing a core tool (`replaces: true`).
- **Dev loop**: `orca2 plugin new <name> [--dir]`, `orca2 plugin check <name|folder>` (load, type-check against
  orca2's types, run its tests in a temporary home), `orca2 plugin enable <name> [--from folder]`.

## Layout

```
src/config   paths (~/.orca2), config.toml, state.sqlite, usage.jsonl
src/api      providers, accounts, OAuth (copied from v1)
src/core     types, transcript, inbox, bubbles, archive, images, loop/, tools/, plugins/, runner/, daemon/,
             session (one run assembled), headless, trust, knowledge (reference sections)
src/tui      OpenTUI view (copied from v1's tui/otui), the app shell, the work page
src/cli      orca2 commands
src/test     shared test fixtures, plugins/example included
skills/      skills shipped with orca2
```

Home: `config.toml`, `mcp.json`, `usage.jsonl`, `archive.sqlite`, `plugins/`, `skills/`, `global/<plugin>/`,
`bubbles/<id>/`, `conversations/<id>/{meta.json, transcript/, inbox/, runs/, logs/, daemon/, data/, images/}`,
`worktrees/<conversation>/<branch>`, `.runtime/` (sign-in, rate-limit state).

## Tests

`bun test` runs everything in a few seconds; `bunfig.toml` preloads a temporary `ORCA2_HOME` for every test file.
`ORCA2_SCRIPTED=<folder>` swaps the model for scripted replies (`<folder>/<agent>.json`) so tests can cross
processes (`src/core/e2e.test.ts`: daemon → worker process in a worktree → report → second turn), and
`ORCA2_SELF` names the argv that runs orca2 itself.
