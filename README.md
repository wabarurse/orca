# parallels

A simple, light-context agent harness with an orchestrator → worker → reviewer loop.

```bash
bun install
bun src/cli.ts start [project] [git-url]
```

`start` opens a bare full-screen TUI with one page per orchestrator (one per
project). Run it inside a git repository and you get an orchestrator for that
repository: an `orch-xxxx` project cloned from its origin (reused next time you
start there). With no project named it also reopens every project under
`~/.parallels/projects`. The row under the tabs shows the page's clone path and
git remote. Ctrl+N starts a new orchestrator named `orch-xxxx`, cloned from the
repository you started in (an empty repository otherwise; `/rename <name>`
renames it; `/new <name> <git-url>` clones from elsewhere), Ctrl+Z and Ctrl+X move between pages
(`/keys` shows what your terminal sends for any chord). Type
`/help` for the rest of the commands.

Everything lives under `~/.parallels`. Design notes are in [PLAN.md](PLAN.md).

## The cycle

The orchestrator first shows how it would split the task and answers questions;
nothing starts until you say "execute" or "dispatch". Then it spawns a
**worker** on a branch; each worker run ends in one
commit and one report. It then spawns a **reviewer**, which reads the diff
against the task's goal, runs the `complexity` tool (cyclomatic and cognitive,
per function) and reports without touching code. Problems go back to the worker
with notes; when the review is clean the orchestrator tells the reviewer to
"watch ci": it pushes, opens the PR, runs `gh pr checks --watch`, fixes what
fails until green, and reports ready to merge. One agent codes on a branch at a
time. `config.toml` holds `maxReviewRounds` (2), `cyclomatic` (10) and
`cognitive` (15).

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
