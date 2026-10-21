# parallels

A simple, light-context agent harness with an orchestrator → worker → reviewer loop.

```bash
bun install
bun src/cli.ts start [project] [git-url]
```

`start` opens a bare inline TUI, like Claude Code and Codex, with one page per
orchestrator (one per project). It does not take over the screen: replies go
into your terminal's normal scrollback (scroll with the terminal or the mouse)
and only the bottom block (a streaming line, menus, the status line and the
input) is redrawn; quitting leaves everything printed in place. The orchestrator's
replies are rendered as markdown (headings, emphasis, lists, quotes, code
blocks, links and box-drawn tables that fit the terminal's width, re-laid out
when it is resized). Run it inside a git repository and you get an orchestrator for that
repository: an `orch-xxxx` project cloned from its origin (reused next time you
start there). With no project named it also reopens every project under
`~/.parallels/projects`. The status line above the input shows the page's name,
git remote and how many pages are open (and a spinner while a turn runs). Ctrl+N starts a new orchestrator named `orch-xxxx`, cloned from the
repository you started in (an empty repository otherwise; `/rename <name>`
renames it; `/new <name> <git-url>` clones from elsewhere), Ctrl+Z and Ctrl+X move between pages,
reprinting the page you switch to (`/keys` shows what your terminal sends for any chord). Type
`/help` for the rest of the commands.

When the orchestrator asks you something (its `ask` tool queues questions
without waiting), the oldest open question shows above the status line, like
Codex's pending questions, with its options numbered, then "type your own
answer" and "skip (use default: …)". ↑↓ or 1–9 choose and Enter picks (Enter
on the skip row lets the orchestrator use its default). Start typing, or
choose "type your own answer", to answer in your own words: the prompt reads
`answer>`, a question without options starts there, and a known command such
as `/help` still runs as a command. Esc never sends anything: it clears what you
typed, and otherwise puts the questions off like Tab, so you can chat, until a
new one arrives or you run `/questions`, which shows them again (and lists
them when there are several). If you were typing a message when a question
arrives, the message stays yours ("send or clear your message to answer"), and
keys pressed in the first half second after a question appears do not answer
it. In an agent view (`/agents`) only the count shows. Each answer leaves one
dim `? question → answer` line. The status line counts open questions on every
page ("orch-x: 2 questions").

Everything lives under `~/.parallels`. Design notes are in [PLAN.md](PLAN.md).

## The cycle

The orchestrator first shows how it would split the task and answers questions;
nothing starts until you say "execute" or "dispatch". Then it spawns a
**worker** on a branch; each worker run ends in one
commit and one report. It then spawns a **reviewer**, which reads the diff
against the task's goal, runs the `complexity` tool (cyclomatic and cognitive,
per function) and reports without touching code. Problems go back to the worker
with notes and the reviewer looks again, for at most `maxReviewRounds` rounds;
if the last review still finds problems, the worker gets one more pass, the
branch goes straight to CI with no further review, and the orchestrator tells
you what was left open. When a review is clean the orchestrator tells the reviewer to
"watch ci": it pushes, opens the PR, runs `gh pr checks --watch`, fixes what
fails until green, and reports ready to merge. One agent codes on a branch at a
time. `config.toml` holds `maxReviewRounds` (1), `cyclomatic` (10) and
`cognitive` (15). `/review-rounds [n]` shows or sets the round count (0 to 100;
a config value outside that, or a `config.toml` that does not parse, falls back
to the defaults); 0 skips review and sends the worker's branch straight to "watch ci".

## Subscription login

Parallels always connects as **Claude Code** for Claude models and **Codex** for
OpenAI models. Those are its only authentication and inference paths.

In the TUI:

```text
/login claude personal
/login codex personal
/accounts
```

`claude` is an alias for `anthropic`; `codex` is an alias for `openai`. Both commands
open the provider's subscription sign-in page. Omit the profile name to use
`default`, or use different names for multiple accounts.

`/accounts` and `/models` open arrow-key menus: ↑↓ then Enter picks an account
(a signed-out one starts its login) or a model, Esc cancels. Each provider's
account is selected independently. `/models <model-id>` sets a model the menu
does not list.

Claude models use the selected Claude subscription. Other models use the selected
ChatGPT/Codex subscription. Account and model changes take effect on the next
orchestrator turn; running workers keep their selection and refresh its tokens
automatically. `/models` reads the providers' catalogs; a listed model can still
require an entitlement your account does not have.

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, developer-platform profiles, and keys from
an old `~/.parallels/credentials.json` are never used. There is no API-key prompt,
override, billing mode, or fallback. Existing OpenAI users must run `/login codex`
once. Old key files are left untouched and can be removed manually.

## Existing CLI logins

You can copy an existing subscription session instead of opening a new login:

```text
/login claude personal --from-claude-code
/login codex personal --from-codex
```

Claude import reads credential files under `CLAUDE_CONFIG_DIR` (default
`~/.claude`), then the macOS `Claude Code-credentials` keychain entry when using
the default directory. Codex import reads `auth.json` under `CODEX_HOME` (default
`~/.codex`) and accepts only ChatGPT subscription tokens. If Codex uses an OS
credential store, use `/login codex` to create a separate browser session.
Imports do not modify either CLI's original store. Browser login gives parallels
independent refresh tokens when you also use the native CLI concurrently.

Browser login requires a browser on the same machine: Claude receives its callback
on `localhost:53692`, Codex on `localhost:1455`. `/quit` cancels a pending login.
Credentials live under `~/.parallels/auth/{anthropic,openai}/` in private (0600)
files with atomic writes and a per-profile lock shared across workers.
`PARALLELS_HOME` relocates parallels' state. Failed login and refresh attempts
preserve the previous credentials.

## Provider implementation

Claude uses Claude Code's public OAuth client ID, PKCE, Bearer authentication,
`claude-code-20250219` / `oauth-2025-04-20` beta headers, and its compatibility
identity. Codex uses its public OAuth client ID and ChatGPT account routing,
with streamed Responses at `chatgpt.com/backend-api/codex/responses`, `store: false`,
and encrypted reasoning replay across tool turns. Neither provider uses OpenAI's
platform Chat Completions or developer-platform OAuth profiles.

The implementation follows [zeta's subscription providers](https://github.com/hwang2409/zeta)
and the [Codex authentication documentation](https://learn.chatgpt.com/docs/auth).
The upstream compatibility contracts can change. Live login and subscription
inference require validation with your account; automated tests use fake tokens.
