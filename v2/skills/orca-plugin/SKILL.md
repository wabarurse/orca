---
name: orca-plugin
description: How to write, check and hand over an orca2 plugin (tools, prompt, skills, storage, hooks, bundles, TUI tabs, background watchers, runners)
---
# Writing an orca2 plugin

A plugin is a folder. orca2 loads it into agents (tools, prompt lines, hooks, bundles), into the TUI (tabs, counts,
commands, tool lines, folds) and into the daemon (watchers, a memory section, a runner). It runs with the user's
permissions, so the user approves every plugin they did not write before it is enabled. You never enable a plugin
yourself.

## The loop

1. `orca2 plugin new <name> --dir <folder>`: a complete plugin that already loads and passes its test. Use your
   working directory (a worktree) for `--dir`; a built-in plugin goes to `v2/src/plugins/<name>`.
2. Edit `index.ts` (and `ui.ts` / `background.ts` if the plugin has them).
3. `orca2 plugin check <folder>`: loads it, type-checks it against orca2's types and runs its `*.test.ts` against a
   temporary home. Fix everything it reports. Run it again after every change.
4. Report to the orchestrator: what the plugin adds, the check output, and the command the user runs:
   `orca2 plugin enable <name> --from <folder>`. That command shows the user what the plugin adds and asks.
   For a built-in plugin, add it to `v2/src/plugins/index.ts` and open a PR instead.

Names: lowercase letters, digits and dashes (`pr-watch`); the folder name and `name` must match; `bubble` and `global`
are reserved (they are `$ORCA_DATA`'s shared folders). Tool names:
lowercase letters, digits and underscores, unique across enabled plugins.

## Folder

```
<name>/
  index.ts        every process: export default the Plugin
  ui.ts           TUI only (optional): export default the PluginUi
  background.ts   daemon only (optional): export default the PluginBackground
  skills/<skill>/SKILL.md   skills agents using the plugin can load
  <name>.test.ts  bun:test tests; plugin check runs them
```

A user plugin imports types only: `import type { Plugin } from "orca2/plugin";`. It must not import orca2's runtime
modules (they are not on its path); everything it needs comes through the context arguments. A built-in plugin in
`v2/src/plugins/` may import `../../core/...` and use `definePlugin`, `defineUi`, `defineBackground`.

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
`"refused: why"` for a refusal that is not a crash. `ctx` gives: `conversation`, `agent`, `role`, `branch`, `cwd`
(the agent's folder), `data` (`$ORCA_DATA`), `signal` (stop when aborted), `model`, `provider`, `settings`, and
`runtime` (`spawn`, `agents`, `stop`, `confirm`). Keep descriptions precise and stable: they are in every request
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
conversation folder; in hooks, UI and background code call `await ctx.data("conversation" | "bubble" | "global")`
(it creates the folder and returns `{ ok: true, data: folder }`, or `{ ok: false, error }`, e.g. `bubble` before the
conversation has one). Agents may read these folders; change them only through your tools. Write files whole
(write a temp file, then rename) so a reader never sees half a file. Deleting a conversation deletes its folder.

### Hooks

Each hook gets the call and a context (`plugin`, `conversation`, `agent`, `role`, `cwd`, `data(scope)`).

- `beforeTool(call, ctx)` → `{ action: "run", input }` (maybe changed), `{ action: "block", reason }`, or
  `{ action: "ask", question }` (the user answers yes/no in the TUI; headless runs answer no unless `--yes`).
- `afterTool(call, { ok, content }, ctx)` → the result, maybe changed.
- `beforeRequest({ system, messages, tools }, ctx)` → the request, maybe changed. Changing `system` or `tools`
  breaks the prompt cache; prefer adding to `messages`.
- `onInput(message, ctx)` → `{ action: "keep", text }` or `{ action: "drop", reason }` for each user message.

A hook that throws blocks the call (beforeTool) or fails the result; keep hooks fast and total.

### Guard

`guard` adds commands agents must never run to the core's list (recursive grep, editors, unbounded git log/diff,
secrets, broad deletes, sudo, curl|sh). Each rule is `{ id, group: "efficiency" | "security", test, reason, suggest }`;
`test(call)` gets `{ tool, input, command, root }` once per simple command of a bash call (`command.program`, `args`,
`env`, `cwd`, `before`/`after` in its pipeline; null for other tools) and returns true to refuse. The model reads
`refused (<id>): <reason>. Use: <suggest(call)>` as the tool result and nothing runs. Keep tests fast and pure.

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

Tabs appear on the work page after Agents (Ctrl+A, then Tab); `chord: "q"` also opens it with Ctrl+Q (avoid
a, c, d, j, k, n, u, v, w: the core uses them). `tone` is normal, good, warn, bad or dim. Action keys must not be
j, k, h, l, q, r or digits. The host offers `note`, `confirm`, `input`, `pick` and `say` (send text to the
orchestrator as the user). Counts show in the composer only when above zero; keep them cheap (they run every 2s).
A fold turns finished calls of a tool into "+ N <title>" with one line per item; `opens` is the tab an item opens.

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

- A watcher runs every `everyMs` (never two at once). `ctx.notify(text)` puts a message in the orchestrator's
  inbox from the plugin, which wakes it: send one notice per real change, never on every poll.
- `memory` is kept verbatim beside the orchestrator's rolling memory at each compaction (a task list, say).
- `runner` starts agents somewhere you can watch them (`start(launch)` runs `launch.argv` in `launch.cwd` with
  `launch.env`, writing to `launch.log`; `alive(conversation)` lists live agent ids or null when unknown;
  `stop(conversation, agent)`). The user picks a runner with `runner = "<name>"` in config.toml.
- `stop` runs when the daemon stops; `remove` when the conversation is deleted, for anything kept outside
  `$ORCA_DATA`.

## Tests

`<name>.test.ts` beside `index.ts`, with `bun:test`. Call tools with a small context object, hooks with a context
whose `data` returns a temporary folder, tabs and counts the same way. `plugin check` sets a temporary
`ORCA2_HOME`; never touch `~/.orca2` or the user's files. Test what is expensive when wrong: storage round trips,
refusals, the hook decisions.

## Mistakes to avoid

- Importing orca2's runtime from a user plugin (types only).
- A changing tool description or prompt line (date, counter): it breaks the prompt cache.
- Writing outside `$ORCA_DATA` or the agent's `cwd`; reading other conversations' data.
- A watcher that notifies on every poll; a count that runs a network call.
- Enabling the plugin yourself or asking the user to approve without showing `plugin check` output.
