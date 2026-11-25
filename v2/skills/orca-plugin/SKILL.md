---
name: orca-plugin
description: How to write, check and hand over an orca2 plugin (tools, prompt, skills, storage, hooks, bundles, TUI tabs, background watchers, runners)
---
# Writing an orca2 plugin

A plugin is a folder. orca2 loads it into agents (tools, prompt lines, hooks, bundles), into the TUI (tabs, counts,
commands, tool lines, folds) and into the daemon (watchers, a memory section, a runner). It runs with the user's
permissions, and approval is recorded for an exact version. When the user asks you to install or update a plugin, use the CLI.

## The loop

1. `orca2 plugin new <name> --dir <folder>`: a complete plugin (index.ts, a test, README.md, an empty skills/) that
   already loads and passes its test. Use your working directory (a worktree) for `--dir`. Plugins never go into the
   orca2 repository. Delete the template's placeholder tool.
2. Edit `index.ts` (and `ui.ts` / `background.ts` if the plugin has them).
3. `orca2 plugin check <folder>`: loads it, type-checks it against orca2's types and runs its `*.test.ts` against a
   temporary home. Fix everything it reports. Run it again after every change.
4. For requested installs use `orca2 plugin enable <name> --from <folder> --yes`. After changing an installed plugin (in place or in a worktree) run `orca2 plugin update <name> [--from <folder>] --yes`: it validates, copies, re-approves the new version and leaves it on or off wherever it was; never use `enable` for that, since it also turns the plugin on. An agent defaults to its own bubble, including from a worker worktree. Use `--global` only for a requested global change. Verify with `orca2 plugin list --json`. Use `show` to inspect a plugin, `disable` to turn it off, and `inherit` to restore the bubble’s default. Group installed plugins in one enable command to approve them together.

Names: lowercase letters, digits and dashes (`pr-watch`); the folder name and `name` must match; `bubble` and `global`
are reserved (they are `$ORCA_DATA`'s shared folders). Tool names:
lowercase letters, digits and underscores, unique across enabled plugins.

## Configuration

Use `orca2 plugin config <name>` to read the effective settings. Use `--set <key> <JSON>` or `--unset <key>` to change a setting the plugin supports. The CLI combines global settings with bubble overrides. Plugin code can read `.orca-settings.json` from its global and bubble data folders in that order. Document the keys your plugin consumes.

## Folder

```
<name>/
  index.ts        every process: export default the Plugin
  ui.ts           TUI only (optional): export default the PluginUi
  background.ts   daemon only (optional): export default the PluginBackground
  skills/<skill>/SKILL.md   skills agents using the plugin can load
  <name>.test.ts  bun:test tests; plugin check runs them
  README.md       what it adds and why
```

A plugin imports orca2 only through `orca2/plugin`, which orca2 provides when it loads the plugin: `definePlugin`,
`defineUi`, `defineBackground`, the types, `ok`/`fail`/`parseJson`/`errorMessage`, `paths`, `z` (zod), and the helpers `writeAtomic(file, text)` (whole-file write), `withStorageLock(path, fn)` (one writer at a time across
processes), `exec(argv)` and `which(name)` (run a CLI from orca2's home; a program on the current PATH) and
`launchCommand(launch)` (the agent launch command every runner uses). Prefer what the contexts give. It never
imports another plugin or orca2's source files directly. What two plugins would share belongs in the core, exported
from `src/core/plugins/api.ts`.

## index.ts: the Plugin

Every field is required; use empty lists and null for what the plugin does not have.

```ts
import type { Plugin } from "orca2/plugin";

const plugin: Plugin = {
  name: "notes",
  description: "One line the user reads when approving it.",
  tools: [{ tool, roles: ["orchestrator", "worker"], replaces: false }],
  prompt: [{ role: "orchestrator", text: "One short line on when to use the notes tool." }],
  skills: ["skills/notes"],
  storage: [{ scope: "conversation", about: "notes/notes.json: the notes" }],
  hooks: { beforeTool: [], afterTool: [], beforeRequest: [], onInput: [] },
  guard: [],
  bundles: [],
  retention: [],
  provides: [],
  uses: [],
  emits: [],
  on: [],
  ui: "./ui.ts",          // or null
  background: null,       // or "./background.ts"
};
export default plugin;
```

### Tools

```ts
const tool = {
  parallel: input => input.action === "list",       // true only for read-only calls
  spec: { name: "notes", description: "What it does and when to use it.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["add", "list"] }, text: { type: "string" } }, required: ["action"] } },
  async run(input, ctx) { return "text the model reads"; },
};
```

`run` returns a string (or text and image blocks). Throwing becomes an error result the model sees; return
`"refused: why"` for a refusal that is not a crash. `ctx` gives: `conversation`, `agent`, `role`, `branch` (null for
the orchestrator), `cwd` (the agent's folder), `data` (the `$ORCA_DATA` root: your folder is `join(ctx.data, "<name>")`
and may not exist yet, so create it), `trusted`, `pluginSkills`, `callId`, `signal` (stop when aborted), `model`,
`provider`, `settings`, and `runtime` (`spawn`, `agents`, `stop`, `confirm`). Keep descriptions precise and stable: they are in every request
and the prompt cache depends on them not changing.

`roles` decides which agents get the tool. `replaces: true` takes the place of a core tool with the same name
(`bash`, `read`, `write`, `edit`, `subagent`, `inbox`, `memory`, `notebook`, `behavior`, `skill`, `web_search`,
`mcp`); keep its input compatible, since prompts mention the core tool.

### Prompt and skills

`prompt` lines are added only to agents whose bundle uses the plugin, one short line each. Put longer guidance in a
skill (`skills/<skill>/SKILL.md` with a `description:` line); agents find it with the `skill` tool.

### Storage: `$ORCA_DATA`

- `$ORCA_DATA/<plugin>/`: this conversation's data (scope `conversation`)
- `$ORCA_DATA/bubble/<plugin>/`: shared by the bubble's conversations (`bubble`)
- `$ORCA_DATA/global/<plugin>/`: shared by everything (`global`)

Declare each scope you use in `storage` with what is kept there. In a tool, `join(ctx.data, "<plugin>")` is the
conversation folder (create it); in hooks, UI and background code call `await ctx.data("conversation" | "bubble" |
"global")`, which creates the folder and returns `{ ok: true, data: folder }`, or `{ ok: false, error }` (e.g. `bubble`
before the conversation has one). Agents may read these folders; change them only through your tools. Deleting a
conversation deletes its folder.

Writing: write files whole (a temp file in the same folder, then rename) so a reader never sees half a file. That
alone does not stop two processes (a worker's tool and the daemon's watcher) from losing each other's update in a
read-modify-write: wrap it in `withStorageLock`, or keep one writer per file (for example one file per record, named
by its id).

Another plugin's data: reading `$ORCA_DATA/<other>/` is allowed (from `ctx.data("conversation")` that is
`join(dir, "..", "<other>")`); writing it is not, so change it by telling the orchestrator, whose tools do.
Say in your description which plugin you read; there is no dependency field, so handle its absence.

### Hooks

Each hook gets the call and a context (`plugin`, `conversation`, `agent`, `role`, `branch`, `cwd`, `data(scope)`).
`afterTool` sees the tool's result as the model got it (text): for a core `subagent spawn`, read the branch and
bundle from the call's input, not from the result.

- `beforeTool(call, ctx)` → `{ action: "run", input }` (maybe changed), `{ action: "block", reason }`, or
  `{ action: "ask", question }` (the user answers yes/no in the TUI; headless runs answer no unless `--yes`).
- `afterTool(call, { ok, content }, ctx)` → the result, maybe changed.
- `beforeRequest({ system, messages, tools }, ctx)` → the request, maybe changed. Changing `system` or `tools`
  breaks the prompt cache; prefer adding to `messages`.
- `onInput(message, ctx)` → `{ action: "keep", text }` or `{ action: "drop", reason }` for each user message.

A hook that throws blocks the call (beforeTool) or fails the result; keep hooks fast and total.

### Guard

`guard` adds commands agents must never run to the core's list (recursive grep, editors, unbounded git log/diff,
secrets, broad deletes, sudo, curl|sh). The bash tool checks every command it is about to run, after the `beforeTool`
hooks, against both lists (`core/tools/bash/guard/`). Each rule is `{ id, group: "efficiency" | "security", test,
reason, suggest }`; `test(call)` gets `{ tool: "bash", input, command, root }` once per simple command of the bash call
(`command.program`, `args`, `env`, `cwd`, `before`/`after` in its pipeline) and returns true to refuse. The model reads
`refused (<id>): <reason>. Use: <suggest(call)>` as the tool result and nothing runs. Rules see bash commands only; to
stop another tool's call, use a `beforeTool` hook. Keep tests fast and pure.

### Retention: archiving and cleaning up

Every row on a plugin tab can be archived: the core keeps which ids are archived (per conversation, in
`archived.json`), shows them under a closed "Archived (n)" heading at the bottom of the tab, and gives the user `a`
(archive), `A` (archive all, after y) and `u` (restore). The plugin stores nothing for this. `retention` adds the rules:

```ts
retention: [{
  tab: "notes",                 // the tab whose row ids these are
  archiveAfterDays: 7,          // a settled item is archived this long after it settled (null: only by hand)
  purgeAfterDays: 14,           // orca2 clean deletes an item archived this long
  settled: async ctx => [{ id: "n1", at: "2026-11-20T10:00:00Z" }],  // finished items and when they finished
  locate: async (id, ctx) => null,          // a file or folder holding the item, to show its size; or null
  purge: async (ids, ctx) => { /* delete these items from your storage */ },
}],
```

The daemon archives due items once an hour; `orca2 clean` archives what is due too, then calls `purge` for items
archived longer than `purgeAfterDays` (`clean --preview` lists them first). An item the user restored with `u` is
never archived again automatically. `purge` deletes only the ids it is given, and an id may already be gone.

### Links: working with other plugins

Plugins never import each other; they reach each other through the core, which looks things up when they are used
(no load order). Every context has `links` (`ctx.links`, `host.links`, a tool's `ctx.links`).

```ts
import { z } from "zod";
import { defineEvent, defineService, listen } from "orca2/plugin";
provides: [defineService("add", "add a note; returns { id }", z.object({ text: z.string() }), async (input, ctx) => ok({ id: "n1" }))],
uses: ["tasks"],                                   // shown on Ctrl+P; a call to a plugin that is off returns an error
emits: [defineEvent("added", "a note was added: { id }", z.object({ id: z.string() }))],
on: [listen("tasks/merged", z.object({ number: z.number() }), async (payload, ctx) => { /* react */ })],
```

- **Services** ask and wait: `await ctx.links.call("notes", "add", { text })` returns `Result<unknown>`; parse it with
  your own Zod schema. The core checks the input against the provider's schema first and runs the provider in its own
  context (its storage, `ctx.from` is the caller).
- **Events** announce: `await ctx.links.emit("added", { id })` reaches every enabled plugin listening to
  `<your plugin>/added`, in the process that sends it. Only declared events can be sent, the payload is checked, and a
  listener that throws does not stop the others. It returns how many listeners ran.
- **The runner** is the one shared contract: `await ctx.links.runner()` is the runner `/mux` chose (plain, tmux, rex or
  a plugin's), `ctx.links.runnerNamed(name)` a specific one. `start` runs any long-lived command under a label,
  `alive`/`stop` take that label, and `attach(conversation, label)` returns how to show it (`host.attach(plan)` in a tab
  action shows it: Rex brings its window forward, tmux takes over the terminal until you detach). A runner plugin
  implements all four; the processes plugin runs its commands this way.

### Bundles

A bundle is an agent preset: `{ name: "scout", role: "worker", prompt: "...", plugins: ["notes"] }`. The
orchestrator starts it with `subagent spawn` (`bundle: "scout"`); its agents are named `scout-<branch>`.
`plugins: ["*"]` uses every enabled plugin.

## ui.ts: the PluginUi

UI is data: return rows and text; orca2 draws them.

```ts
import type { PluginUi } from "orca2/plugin";
const ui: PluginUi = {
  tabs: [{ id: "notes", title: "Notes", chord: null,
    rows: async ctx => [{ id: "n1", name: "first note", status: "new", info: "today", tone: "normal" }],
    details: async (row, ctx) => [{ title: "Note", lines: ["full text"] }],
    actions: [{ key: "d", label: "delete", run: async (row, host) => { if (row && await host.confirm("delete?")) host.note("deleted"); } }] }],
  counts: [{ id: "notes", count: async ctx => 3, label: n => `${n} notes` }],
  commands: [{ name: "note", description: "add a note", run: async (args, host) => { host.note("added"); } }],
  toolLines: { notes: { label: input => `notes(${String(input.action)})`, summary: o => ({ summary: o.text.split("\n")[0] ?? "", failed: !o.ok }) } },
  folds: { notes: { title: n => `${n} notes`, items: (input, o) => o.ok ? [String(input.text)] : [], opens: "notes" } },
};
export default ui;
```

Tabs appear on the work page after Agents (Ctrl+A, then Tab); `chord: "q"` also opens it with Ctrl+Q. The core
uses Ctrl+ a, c, d, j, k, n, u, v, w; the questions and tasks plugins take q and t. On the page the core uses j, k, h,
l, q, r, a, A, u (archive and restore), the digits, Tab, Esc, PgUp/PgDn, and s on the Agents tab; any other single
character is yours for actions, and `key: "enter"` runs on Enter.
`tone` is normal, good, warn, bad or dim. A tab belongs to one plugin: rows cannot be added to another plugin's tab.

The host is the tab's `PluginContext` (so `host.conversation`, `host.data(scope)` work) plus `note`, `confirm`,
`input`, `pick`, `say` (text to the orchestrator as the user, queued as steer input; there is no receipt) and
`open(path)` (the desktop viewer). Commands are global: if two enabled plugins define the same name, the first
wins. Counts show in the composer only when above zero; keep them cheap (they run every 2s). A fold turns
finished calls of a tool into "+ <title(n)>" with one line per item (`title(n)` includes the number:
`n => \`${n} notes\``); `opens` is the tab an item opens.

## background.ts: the PluginBackground

Runs only in the conversation's daemon.

```ts
import type { PluginBackground } from "orca2/plugin";
const background: PluginBackground = {
  watchers: [{ name: "poll", everyMs: 30_000, run: async ctx => { /* ctx.notify(text) tells the orchestrator */ } }],
  memory: { title: "Notes", text: async ctx => "- n1: first note" },
  runner: null,
  stop: null,
  remove: null,
};
export default background;
```

- A watcher runs every `everyMs` (never two at once), in the daemon, while it runs. `ctx.notify(text)` puts a
  message in the orchestrator's inbox from the plugin, which wakes it; `ctx.tell(agent, text)` messages one agent
  (rerouted to the orchestrator when that agent is not running); `ctx.agents()` lists the agents and their states.
  Send one notice per real change, never on every poll; record what you already told.
- `memory` is kept verbatim beside the orchestrator's rolling memory at each compaction (a task list, say).
- `runner` starts agents somewhere you can watch them. `start(launch)` runs `launch.argv` in `launch.cwd` with
  `launch.env`, writing output to `launch.log`, and returns `{ handle, pid }`; `pid: null` is fine, since every agent
  records its own pid and the core judges liveness by it. `launch.env` is the whole environment and may hold
  credentials: never put it in argv or the multiplexer's options (write a 0600 file the command sources and deletes).
  `alive(conversation)` lists the agent ids the runner still holds (null when it cannot tell) and `stop(conversation,
  agent)` ends one; the core calls `stop` for agents this runner started. `name` should equal the plugin name: the
  user selects it with `/mux` in the TUI (a core command listing plain and every enabled plugin runner) or
  `runner = "<name>"` in config.toml; with none enabled the core's plain runner starts agents. Build `start` on
  `launchCommand(launch)`: it puts `launch.env` in a 0600 file the command sources and deletes, and tees the output
  to `launch.log`; run its `argv` and call its `cleanup()` when the window never opened.
- `stop` runs when the daemon stops (an `orca2 stop`, a deletion, or a signal; not after a crash): processes you
  started may keep running and the next daemon's watcher can pick them up. `remove` runs when the conversation is
  deleted, for anything kept outside `$ORCA_DATA` (and to kill what you started).
- There is no hook for an agent ending; a watcher can notice it through `ctx.agents()`.

## Tests

`<name>.test.ts` beside `index.ts`, with `bun:test`. Every test process already runs with a temporary `ORCA2_HOME`
(the plugins folder's preload, and `plugin check`); never touch `~/.orca2` or the user's files. A test creates a
conversation with `createConversation(dir, name)` and takes its fakes from `orca2/plugin/testing`:
`toolContext(conversation, cwd, overrides)` for tools, `pluginContext(conversation, "<name>", cwd)` for hooks and tabs,
`recordingHost(ctx, answers)` for tab actions and commands (it records `note`, `say` and `open`), and `item`,
`present` and `unwrap` in place of `!` and casts; background code gets `backgroundContext(conversation, "<name>", dir)`
or a recording fake. Test what is expensive when wrong: storage round trips, refusals, the hook decisions.

Faking a CLI (tmux, gh): prefer an injectable runner. If you put a fake binary on PATH, look the program up with
`Bun.which(name, { PATH: process.env.PATH })` (plain `Bun.which` ignores PATH changed at runtime and finds the real
one) and assert the fake was the one found. eslint runs with inline config disabled: `// eslint-disable` comments
do nothing, fix the code instead.

## Mistakes to avoid

- Importing orca2's runtime from a user plugin (types only).
- A changing tool description or prompt line (date, counter): it breaks the prompt cache.
- Writing outside `$ORCA_DATA` or the agent's `cwd`; reading other conversations' data.
- A watcher that notifies on every poll; a count that runs a network call.
- Enabling plugins the user did not request or reporting success without checking the effective scope.
