# parallels

A simple, light-context agent harness with an orchestrator → worker → reviewer loop.

```bash
bun install
bun src/cli.ts start [project] [git-url]
```

`start` opens a TUI with one page per orchestrator (one per project). Orchestrator
tabs and project details stay at the top; the input, counts and panels stay at
the bottom. The conversation scrolls between them with Page Up/Page Down or the
mouse wheel when the terminal delivers mouse reports. Use the terminal's selection
modifier (often Shift) for native text selection. Only changed screen rows are
redrawn. All saved conversation, including original history before compaction,
is reachable by scrolling inside the app; startup does not discard older messages
from the live viewport. Quitting restores your shell and prints the active
conversation into its normal scrollback. Apple Terminal's ordinary wheel behavior
still needs native verification: see [terminal isolation](TERMINAL_ISOLATION.md)
if a gesture reveals prelaunch shell history instead of scrolling the conversation.
The orchestrator's replies are rendered as markdown (headings, emphasis, lists, quotes, code
blocks, links and box-drawn tables that fit the terminal's width, re-laid out
when it is resized). Run it inside a git repository and you get an orchestrator for that
repository: an `orch-xxxx` project cloned from its origin (reused next time you
start there). With no project named it also reopens every project under
`~/.parallels/projects`. The ruled, pinned header shows bracketed project/display names (the active one
marked `>`), cached model, effort, fast mode, directory and remote, and refreshes
when settings change.
Short terminals collapse header details to keep the input usable.
The bottom band puts queued prompt previews immediately above the boxed input,
then grouped running worker/reviewer, queued-message and **Inbox** counts (unanswered questions only); these
stack on narrow screens. Every menu
and user inbox opens below the input and retains its own key hints. There
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
still work, and Ctrl+Q replaces help with the Inbox's Questions section.

`/clear` clears only the current orchestrator's **model context**, after a local
confirmation. **Cancel is selected by default** (Enter alone cancels); choose
**Clear context**, then Enter to confirm. Esc cancels without changing drafts.
Saved conversation/UI history, system/tool instructions, settings/accounts, files,
questions and worker/reviewer sessions stay intact. It refuses while the
orchestrator is running/compacting or any input is queued (including paused inbox
messages and sign-in-held prompts). Return from agent views with `/back` first.
Clearing makes no model request and never retries or restarts work. Page changes
and resize cancel the confirmation. See [COMPACTION.md](COMPACTION.md) for persistence
and later-compaction semantics; `/compact` remains the summarizing alternative.

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
or responses. Until then the pinned footer previews text submitted here above the
composer, in submission order, labelled `Queued shown/total · orchestrator · project`. The
previews use the existing inbox/sign-in-held tracking, not another delivery
queue; drafts and already consumed messages are never queued previews. Multiline
prompts use `↵`, long text ends in `…`, and the heading counts hidden items. The
area is capped at six rows and a third of the space below the header, leaving
conversation and composer space; at tiny sizes input/status take precedence.
Switching projects selects that project's queue and draft (including its cursor).
When viewing an agent, the footer still labels the queue as the **orchestrator's**.
Successful inbox writes, turn completion and cancellation are not consumption.
Submitting never interrupts a running tool. Assistant message identity is retained
across streamed paragraph/quote/list
source lines and transcript entries. Logical conversation blocks have a neutral blank
row between them, not between a tool's label and result or wrapped rows.

The orchestrator should reserve questions for necessary unresolved decisions, not
routine approved work. Clear answers and authorization in chat count, but do not
close existing queued questions.

The per-project **USER inbox** (`/inbox`) has **Tasks / Questions**, not an agent
list: `/agents` stays separate. **Shift+Tab** switches sections; **Esc/Tab** closes.
The footer **Inbox N** counts unanswered questions only (not tasks, queued prompts
or agents); **0** is a successful empty read and **?** means unknown/failed data.
Background pending questions show **(+N elsewhere)** (shortened on narrow screens),
with **?** for unknown background data. Task and question stores remain distinct.

Questions never open automatically or take your draft. Ctrl+Q or `/questions`
opens the Questions section with the oldest pending question below the input, with numbered options,
"type your own answer" and "skip (use default: …)". ↑↓ or 1–9 choose and Enter
picks. Typing switches to `answer>`; an optionless question starts there.
Esc, Tab or Ctrl+Q closes the panel without answering or skipping, and restores
your chat draft. The answer draft and cursor are retained across sections, closing and project switches.
Project switches close Inbox; explicitly reopen to resume the answer. Only selecting
"skip" and pressing Enter skips. New arrivals update the count, not the input.
Answering the last question closes the panel; a later question needs explicit
opening again. Explicitly opening an empty queue shows No open questions. A half-second guard after opening prevents accidental answers.
Menus take precedence over questions; Ctrl+Q does nothing while a menu/project
list is open. On a one-row terminal the input takes the whole live region: a modal panel
can be hidden while still owning keys; Esc closes it. In an agent view Questions
shows a guard, never an answer field: close Inbox, then Esc or `/back` to the
project orchestrator before answering. Each answer leaves a
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

## Tool efficiency

Claude prompt-prefix caching is enabled by default (`anthropicPromptCache = true`
in `~/.parallels/config.toml`). It reuses eligible prefixes without rewriting
instructions or history. Cached tokens still occupy context; caching does not
replace compaction or guarantee faster responses.

Bash streams full output into private files under
`~/.parallels/projects/<project>/tool-outputs/`, outside the repository.
Normal output up to `maxToolResultBytes` (16 KiB by default) stays intact.
Larger output returns a head/tail preview of at most 4 KiB and the saved file path,
which the model can inspect with bounded shell reads. `max_output_bytes` adjusts a
call's preview from 512 bytes up to the configured cap (at most 64 KiB).
A command exceeding `maxToolOutputBytes` (64 MiB by default) is terminated;
its saved output is explicitly partial, as are timeouts and cancelled commands.
Before the next command, completed outputs are pruned to seven days and a
256 MiB project budget. Active files are excluded until stale, and newly completed
files can temporarily exceed the budget. Saved output is temporary, not an archive.

The model can mark independent read-only Bash calls with `independent = true`.
Up to `toolConcurrency` calls (default 4, configurable 1–32) overlap within a
batch; all other calls are ordering barriers. Tool results retain request order.
Edits and calls depending on earlier results must stay ordered. This flag is a
model contract, not a shell sandbox. Set concurrency to 1 for sequential execution.

## Web search

There are **seven tools**: `bash`, `spawn`, `message`, `ask`, `complexity`,
`web_search`, and `task`. Search and structured task access are available to every
role (orchestrator: 6 tools, worker: 4, reviewer: 5). Search uses the current model's
existing Claude/Codex subscription, with no extra API key, search service, slash
command or browser tool.

`web_search` accepts a public `query` and optional `max_results` (1–10, default 5),
and returns source URLs, titles and actual quoted excerpts where supported.
Results are untrusted data, not instructions. Use only public search terms, never
secrets or project content. Search has a 60-second timeout and bounded output;
unsupported/unfinished native searches fail explicitly, without a billing,
provider or shell fallback. Subscription/model capability has **not** been
live-validated. See [WEB_SEARCH.md](WEB_SEARCH.md) for provider evidence, privacy,
limits and attribution/compaction semantics.

### Structured task data

Authorized work is registered with the `task` tool before `spawn`, with immutable
task IDs independent of branch reuse. The persisted registry exposes task name,
summary, queued/working/reviewing/ready-to-merge status and a verified PR link;
confirmed merges archive rows without deleting history. Readiness requires an
explicit reviewer validation of the current PR head. This is separate from
message/question/prompt queues.

**`/inbox`** opens the USER inbox’s **Tasks** section: a read-only
**Name | Summary | Status | PR link** table below
the composer/counts, showing only the selected project's active registered tasks.
Waiting/blocked/cancelled/closed/unknown attention and query errors stay explicit;
empty means no active registered tasks, not that unregistered work completed.
Scroll with ↑/↓, Page Up/Down, wheel or Home/End; **r** refreshes the local snapshot;
**Esc/Tab** closes without submitting or changing drafts. **Shift+Tab** switches
Tasks / Questions; Ctrl+Q goes directly to Questions; project changes close it and discard late reads. The existing
poll/watchers refresh rows, so confirmed merged PRs disappear without deleting
archive history. Long fields/verified URLs wrap; narrow terminals use labelled
records. Links use the canonical structured URL (OSC 8 where supported); no browser
command is launched. Status is last observed, not a real-time GitHub guarantee.
See [TASK_INBOX.md](TASK_INBOX.md) for navigation, read-only/isolation guarantees,
the API, lifecycle, terminal limitations and storage limits.
