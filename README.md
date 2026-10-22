# parallels

A simple, light-context agent harness with an orchestrator → worker → reviewer loop.

```bash
bun install
bun src/cli.ts start [project] [git-url]
```

`start` opens a TUI with one page per orchestrator (one per project). Orchestrator
tabs and project details stay at the top; the input, counts and panels stay at
the bottom. The conversation scrolls between them with Page Up/Page Down or the
mouse wheel. Hold Shift for native terminal text selection. Only changed screen
rows are redrawn. Quitting restores your shell and prints the active conversation
into its normal scrollback, including original history before compaction and
messages omitted from the bounded startup viewport. The orchestrator's
replies are rendered as markdown (headings, emphasis, lists, quotes, code
blocks, links and box-drawn tables that fit the terminal's width, re-laid out
when it is resized). Run it inside a git repository and you get an orchestrator for that
repository: an `orch-xxxx` project cloned from its origin (reused next time you
start there). With no project named it also reopens every project under
`~/.parallels/projects`. The ruled, pinned header shows bracketed project/display names (the active one
marked `>`), cached model, effort, fast mode, directory and remote, and refreshes
when settings change.
Short terminals collapse header details to keep the input usable.
The bottom band puts the boxed input first, then grouped running worker/reviewer,
queued-message and question counts; these stack on narrow screens. Every menu
and question panel opens below the input and retains its own key hints. There
is no persistent shortcut row; Ctrl+B, Ctrl+Q and the other keys still work.
A running turn's "thinking…/working…" shimmers at the selected conversation's
current tail, not in the pinned footer. Scrolling back hides that activity with
the tail; it never enters history. Like Codex, the input and your own messages sit on a
subtle background the full width of the terminal, shaded from your terminal's
own background colour (asked once at start; a neutral grey when the terminal
does not say; none with `NO_COLOR`). Tool calls show like Claude Code's: while
one runs, a shimmering `⏺ Bash(git status)` line sits at the conversation tail
instead of a separate working indicator; when it ends, that line goes into the
conversation history with one summary line under it
(`⎿  12 lines`, `exit 2: <first error line>`, `sent to orchestrator`,
`spawned worker-feat`), its marker red when it failed. A call whose run stops
without a result is red with an `interrupted` summary. Truncated bash output
shows `N+ lines (truncated)`. Restored pages and the
`/agents` view show calls the same way. Ctrl+N starts a new orchestrator named `orch-xxxx`, cloned from the
repository you started in (an empty repository otherwise; `/rename <name>`
renames it; `/new <name> <git-url>` clones from elsewhere), Ctrl+Z and Ctrl+X move between pages,
reprinting the page you switch to (`/keys` shows what your terminal sends for any chord). Type
`/help` for grouped commands and keyboard shortcuts in a panel below the input
and counts, not in the conversation history. Scroll help with ↑/↓, Page Up/Down
or the wheel; Home/End jumps to its start/end (including advanced diagnostics).
Esc closes it without changing your draft or leaving an agent view. Help is
read-only while open; close it before typing. Global cancellation/page shortcuts
still work, and Ctrl+Q replaces help with the explicit question toggle.

Ctrl+C cancels the selected page's current turn (including its provider request
and running tools), without closing the harness or clearing your draft/history.
Other projects' turns and background workers/reviewers keep running. The cancelled
orchestrator stays paused even if agent reports arrive; your next chat message
resumes its saved conversation. While viewing a subagent, Ctrl+C instead stops
only that worker/reviewer, preserving its transcript and worktree; the existing
`spawn` continuation path can restart it with that conversation. Agent views remain
read-only (`/back` to talk to the orchestrator). A hint appears on the first press;
a second Ctrl+C within two seconds exits the harness (`/quit` also exits). Exiting
cancels in-process orchestrator turns but leaves background agents alone.

Cancellation notices use `[agent-cancelled]`, not crash recovery's `[agent-exit]`:
the orchestrator must leave the agent stopped until the user explicitly authorizes
continuation. Input submitted before cancellation (including messages held during
login or still being persisted) stays queued but cannot resume a paused turn.
Ordering uses submission epochs rather than millisecond timestamps; a later UI,
CLI, or question reply resumes even in the same clock tick.

Cancellation cannot undo side effects already completed by tools. Shell cancellation
kills the shell's process group (including ordinary children); independently detached
processes/services are not owned by that group. Incomplete provider output is not
added to model history. Already-recorded tool calls receive matching error results
for cancelled/skipped tools, so the next request has a valid transcript.

Pressing Enter puts a chat message in the orchestrator's inbox; it appears in
the conversation only when the orchestrator consumes it, between tool batches
or responses. Until then the bottom band counts it as queued. This never
interrupts a running tool. Assistant message identity is retained across streamed paragraph/quote/list
source lines and transcript entries. Logical conversation blocks have a neutral blank
row between them, not between a tool's label and result or wrapped rows.

Questions never open automatically or take your draft. Ctrl+Q or `/questions`
opens the oldest pending question below the input, with numbered options,
"type your own answer" and "skip (use default: …)". ↑↓ or 1–9 choose and Enter
picks. Typing switches to `answer>`; an optionless question starts there.
Esc, Tab or Ctrl+Q closes the panel without answering or skipping, and restores
your chat draft. The answer draft is retained for reopening. Only selecting
"skip" and pressing Enter skips. New arrivals update the count, not the input.
When the queue is empty the panel closes; a later question needs explicit
opening again. A half-second guard after opening prevents accidental answers.
Menus take precedence over questions; Ctrl+Q does nothing while a menu/project
list is open. On a one-row terminal the input takes the whole live region: a modal panel
can be hidden while still owning keys; Esc closes it. In `/agents` only the question count shows. Each answer leaves a
dim `? question → answer` line; background projects' question counts are shown too.

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
time: spawn waits briefly and then refuses while the branch's worker or reviewer
is still running. A small follow-up on a branch that has not gone to CI yet can
reuse it (its worker keeps its context); other work gets a new branch.

When a branch's PR is merged, the TUI notices within about 30 seconds (it asks
`gh pr list --repo <origin> --state merged` for each open project whose origin
is on GitHub; without `gh` nothing happens): it stops that branch's worker and
reviewer, removes the worktree and the local and remote branch, deletes their
transcripts, fast-forwards the project's checkout of main, and tells the
orchestrator, which tells you and starts whatever was waiting on that branch.
The worktree is removed with `git worktree remove --force`, so ignored files in
it, such as `.env`, are deleted too. Everything is kept, and the message says
why, when the worktree has uncommitted changes, is on another branch, or the
branch has commits that are not in the merged PR, or when an agent does not
stop. PRs from forks, closed-unmerged PRs, branches without a PR, main and
origin's default branch are never touched.

`config.toml` holds `maxReviewRounds` (1), `cyclomatic` (10) and
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

## Web search

There are **six tools**: `bash`, `spawn`, `message`, `ask`, `complexity`, and
`web_search`. Search is available to every role (orchestrator: 5 tools, worker: 3,
reviewer: 4). It uses the current model's existing Claude/Codex subscription,
with no extra API key, search service, slash command or browser tool.

`web_search` accepts a public `query` and optional `max_results` (1–10, default 5),
and returns source URLs, titles and actual quoted excerpts where supported.
Results are untrusted data, not instructions. Use only public search terms, never
secrets or project content. Search has a 60-second timeout and bounded output;
unsupported/unfinished native searches fail explicitly, without a billing,
provider or shell fallback. Subscription/model capability has **not** been
live-validated. See [WEB_SEARCH.md](WEB_SEARCH.md) for provider evidence, privacy,
limits and attribution/compaction semantics.
