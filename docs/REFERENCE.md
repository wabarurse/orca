# Parallels reference

[Getting started](../README.md) · [Documentation index](README.md)

Repository file paths in this guide are relative to the repository root.

Parallels is a terminal app that helps you work on a Git repository with AI agents.
Discuss a task with an **orchestrator**, approve a plan, then let a **worker** make
changes on a separate branch and a **reviewer** check the result.

## Quick start

### 1. Check prerequisites

- **macOS or Linux**, with **git** and **tmux** on your `PATH`.
- [Bun](https://bun.sh/docs/installation) **1.4.2 or newer** to build and update.
  The installed executable does not need Bun on its runtime PATH.
- Read access to this repository to clone the app. Authenticate Git first if
  repository access requires it.
- A **Claude or ChatGPT/Codex subscription account** with access to your chosen
  model, and a browser on the same machine for sign-in. API keys are not supported.
- Optional: [GitHub CLI (`gh`)](https://cli.github.com/), authenticated with
  `gh auth login`, for GitHub PRs and CI. Publishing also needs Git push access.
  Have your project's own build/test tools installed too.

Agents can run shell commands and edit files. Use a repository you trust and
review their work; this is not a shell sandbox.

### 2. Install once

Keep the app separate from your work repositories. Run this in your shell to
build from source in `~/.parallels/app` and install `~/.local/bin/parallels`.
The checks refuse existing paths and symlinks instead of overwriting them; if
installation refuses, inspect the paths and read
[ownership and recovery](#installer-ownership-and-recovery).

```sh
(
  set -eu
  # Never replace an existing app or follow a symlink into unrelated content.
  if [ -L "$HOME/.parallels" ] || [ -e "$HOME/.parallels/app" ] || [ -L "$HOME/.parallels/app" ]; then
    echo "Existing app or symlink: inspect it first; use the update steps for your own clone." >&2
    exit 1
  fi
  mkdir -p "$HOME/.parallels"
  git clone https://github.com/wabarurse/parallels.git "$HOME/.parallels/app"
  cd "$HOME/.parallels/app"
  # To install an exact reviewed revision, first: git switch --detach <reviewed-commit>
  bun install --frozen-lockfile
  bun run install:local
)
```

For this shell session, make the executable available and check which one runs:

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v parallels
parallels version
```

For a permanent PATH change, see [installation details](#install-once-run-from-any-repository).
You can also use `"$HOME/.local/bin/parallels"` directly.

### 3. Open your repository and sign in

In your shell, go to an existing local repository. Check `git status` and resolve
local work before switching to its default branch (`main` below; substitute your
repository's default branch if different). Parallels will not switch or stash for you.

```sh
cd /path/to/your/repository
git status --short
git switch main
parallels
```

The terminal UI opens with an orchestrator working in your **original checkout**
on its default branch, not a new clone. Workers use separate worktrees beside
that checkout; reviewers reuse the worker's worktree. Uncommitted changes and
untracked/ignored files such as `.env` are not copied into those worktrees.
Start from the local checkout, not a remote URL. Saved projects also reopen.

Inside the TUI, sign in to the provider you want to use:

```text
/login claude
```

Or, for ChatGPT/Codex:

```text
/login codex
```

Complete browser sign-in, then use `/accounts` to check the account and `/models`
to select a model from that provider (↑/↓, Enter; Esc cancels). Login selects an
account, not a model; catalog entries may require an entitlement you do not have.
See [subscription login](#subscription-login) for profiles and
[existing CLI logins](#existing-cli-logins) for importing a session instead.
Long conversations use OpenAI for [rolling memory](#orchestrator-rolling-memory),
so that feature needs `/login codex` even when your foreground model is Claude.

### 4. Try a small task

For example, type this into the TUI:

```text
Plan a small README improvement explaining how to run this project's tests.
Do not execute yet. Keep the work local: do not push or open a PR.
```

Review the plan, then reply `execute` when you are happy with it. Expect a worker
branch, a commit and report, then review. The normal full workflow proceeds to
publishing a PR and watching CI; the explicit local-only request above avoids
that for your first task. Set up `gh` and Git push access before requesting the
full workflow. See [the cycle](#the-cycle) for review limits and post-merge
branch/worktree cleanup, including removal of ignored files.

### Help and updates

- `/help` shows commands and shortcuts; Esc closes it. `parallels --help` shows
  shell commands outside the TUI.
- `/agents` shows agents; `/back` returns to the orchestrator. `/inbox` shows
  registered tasks, and `/questions` (or Ctrl+Q) opens questions needing answers.
- Ctrl+C cancels the current turn; `/quit` exits. Background workers/reviewers
  can keep running; see [Using the TUI](#using-the-tui) for cancellation details.
- Finish active work and let background agents exit, then run `parallels pull`
  from any directory to update **only the dedicated app installation**. Git and
  Bun 1.4.2+ are required. Restart afterward; existing processes are not upgraded.
  Read [update safety and recovery](#explicit-updates-parallels-pull) before updating.

## Install once, run from any repository

Supported hosts: **macOS or Linux** with **git** and **tmux** on `PATH`. Building
and updating also require **Bun 1.4.2 or newer** (TypeScript and the other build
dependencies are installed by `bun install`). The compiled executable includes
its runtime: **Bun and the harness source are not needed on runtime PATH**, even
for background workers/reviewers and their crash-reporting follow-up. Install a
native build on each OS/architecture; this is not a cross-platform binary.
Standard system tools (`sh` and `env`) must also remain on PATH.
`gh` and project-specific tools may additionally be needed for the work you ask
agents to do (for example PR publication/review).

Keep the harness checkout separate from the repositories you work on. This
local-only workflow installs the app at `~/.parallels/app` and the executable at
`~/.local/bin/parallels`; it does not download or run a remote bootstrap script.

Follow the [quick-start installation steps](#2-install-once) above.

`install:local` builds `dist/parallels` from that checkout, then copies it to
`$HOME/.local/bin/parallels` with executable permissions. It works even when
invoked by an absolute script path from another directory. It never replaces
`~/.parallels` itself, changes auth/config/projects, moves your repositories, or
edits shell startup files. `PARALLELS_HOME` still relocates **runtime state**;
it does not change the app checkout or executable installation destination.

If `~/.local/bin` is not on your PATH, for the current sh/bash/zsh session use:

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v parallels
parallels version
```

For future sessions, add that export to the appropriate shell startup file
**yourself**, or use your shell's equivalent (e.g. `fish_add_path ~/.local/bin`
in fish). Check `command -v parallels` for another executable shadowing this
one. You can always invoke `"$HOME/.local/bin/parallels"` directly.

```sh
cd /path/to/any/repository
parallels
# Equivalent explicit form; optional project and local directory:
parallels start [project] [directory]
parallels msg <project> <text>
parallels version
parallels --help
```

Bare invocation and `start` need an interactive terminal. Launching does **not**
`cd` into the installation directory: repository detection uses the invoking
working directory, including repository subdirectories. The main agent works
in your **original checkout on its default branch** (origin/HEAD, otherwise
main or master). Local files, Git configuration and repository-local logins
remain available. If the checkout is on another branch, switch it yourself
when safe; the harness never switches or stashes your work. It checks the
branch again before each main-agent turn.

Workers use task branches in Git worktrees beside the original checkout:
`<checkout>.parallels-worktrees/<worktree-id>/<branch-slug>`. Reviewers reuse
the worker's worktree. These share Git objects and repository-local config with
the original checkout, including later login updates. Worktrees do not contain
the original's uncommitted changes or untracked/ignored files such as `.env`;
project setup must provision files needed in each worktree. New agents inherit
the launch process's exported environment (HOME, PATH, auth variables and agent
sockets), even when tmux was started with older values. Private temporary
environment handoffs delete themselves before starting the agent; values are
not placed in command arguments or tmux options. This does not transfer browser
sessions or logins in a different OS account/container.

`$PARALLELS_HOME/projects` (default `~/.parallels/projects`) stores conversations,
tasks and a `repository.json` reference, not a new source clone. Discovery uses
the canonical checkout path, so two clones with the same origin stay distinct.
Multiple conversations sharing a checkout serialize their main-agent turns.
Remote URLs are no longer cloned by `start` or `/new`: clone locally first and
pass the directory. Starting outside Git requires an existing project or an
explicit local checkout; no empty repository is created inside harness state.

Existing clone-based projects remain usable with their original paths and
history; they are not automatically rebound or deleted. Start from your original
checkout to create a new project using this layout. Normal no-project startup
also reopens saved projects. Deleting a new project removes its state and clean
worktrees, preserving the original checkout and local branches; local worker
files (including ignored files) block deletion. Background merge cleanup never
pulls or changes the original checkout. Update main explicitly when needed.

### Clipboard image attachments

In project chat, **Ctrl+V** attaches a clipboard image, **Ctrl+Y** removes the
last attachment, and Enter sends text plus images (or images alone). Escape
clears the draft. Normal terminal text paste is unchanged. Native macOS uses
system AppKit through `osascript`; Linux uses existing `wl-paste`/`xclip`, with
no helper installation. Draft labels never contain base64. Queued/history
attachments are durable, and `/retry-images` explicitly retries unconfirmed
image prompts with their original IDs. Agents can forward selected attachments
to workers/reviewers; Claude and Codex receive actual pixels.

See [IMAGE_ATTACHMENTS.md](IMAGE_ATTACHMENTS.md) for terminal boundaries, limits,
model admission, queue recovery, retention/privacy, compaction and test coverage.

### Explicit updates: `parallels pull`

Finish active work and let background agents exit before upgrading. From **any**
directory (including an unrelated repository), run:

```sh
parallels pull
# Or, if another command shadows it:
"$HOME/.local/bin/parallels" pull
```

This command accepts no arguments. It updates **only the dedicated harness
installation** at `$HOME/.parallels/app`, never the invoking repository or a
managed project. `PARALLELS_HOME` still relocates runtime state, not the updater's
checkout or executable. Git and **Bun >= 1.4.2 on PATH** are required for updates;
Bun is not required for normal compiled runtime. An initial clone and successful
`bun run install:local` are required first; `pull` does not create or guess a
missing installation.

The updater validates the app's path/ownership, requires its own `.git` directory
(not a symlink, shared-object clone or linked worktree), and checks that both the
raw and effective origin URL are exactly
`https://github.com/wabarurse/parallels.git`. SSH URLs, forks, local replacements,
and local URL rewrites are refused. Inherited Git repository/config overrides
and non-authentication global/system Git settings are ignored, and Git hooks are
disabled for this operation. Fetch retains system/global `credential.*` settings,
including Keychain, Git Credential Manager and configured `gh` helpers, in their
normal order with local overrides. Only those settings enter a private temporary
config, deleted after the fetch succeeds or fails; credentials are not put in
command arguments or copied into the harness checkout. Terminal prompts remain
disabled. It fetches only main from that verified URL, **fast-forwards only**,
runs `bun install --frozen-lockfile` and `bun run build` in the app checkout, then
uses the same ownership-checked atomic installer as `install:local`. This runs
build/dependency code from origin/main; review/trust that upstream before pulling.
It does not run the full test suite for you. Even an up-to-date checkout is rebuilt
and reinstalled, so a failed dependency/build step can be retried.

Checkout behavior is deliberately conservative:

- **main:** advance only when current HEAD is an ancestor of fetched origin/main.
  Local-only/ahead/divergent commits are not reset or discarded.
- **Detached exact-reviewed installation:** advance only when that reviewed HEAD
  is an ancestor of origin/main, and remain detached. This works after an
  ancestry-preserving merge. An unmerged PR head or a squash/rebased merge can
  fail this check; preserve the reviewed head in a named branch, inspect the
  history, and manually choose the desired checkout before retrying. The updater
  does not guess that different commit IDs contain equivalent changes.
- **Any other branch:** refuse. Preserve its work, then explicitly select main or
  a suitable detached revision yourself. No branch is silently switched/deleted.
- Dirty/untracked source, Git operations in progress, unsafe paths (including
  symlinked `dist` or `node_modules`), conflicting installs, and concurrent
  installer/updater operations are refused. There is no automatic stash, reset,
  clean, force-overwrite, or session restart.

Fetch/dependency/build/installation failure leaves the previously installed
executable intact. The app's fetched refs, checkout or dependencies **may already
have advanced** before a later failure; they are not rolled back. Inspect the
error, preserve any local work, resolve it, then rerun `parallels pull`. Do not
blindly delete files to make the check pass. A failed build does not require
resetting the checkout.

**Existing processes keep the code they already loaded.** Nothing is stopped,
killed or restarted. New launches use the replacement executable; an old
worker/reviewer shell wrapper can also re-enter that new executable for its
`agent-exit` follow-up. Mixed protocol/code versions are therefore possible if
you update during a run: update **between active runs**, then start a new session
when ready. Source-development processes are not upgraded in place either.

### Installer ownership and recovery

Both `install:local` and `pull` refuse unrelated existing `parallels` files,
symlinks (including dangling links and symlinked `.local` / `bin` directories),
directories at file destinations, and files not owned by you or writable by
other users. Neither modifies shell startup files or auth/config/projects.
The installer records the binary's SHA-256 in
`~/.local/bin/.parallels-install.json`; keep this receipt alongside the executable.
An upgrade is permitted only when the current executable matches that receipt.
The binary is staged on the same filesystem and replaced with one atomic rename,
so build/copy failure leaves the previous executable intact and an already-open
executable is not truncated. The receipt is published separately **before** the
final binary rename (and restored if that rename fails). Abrupt interruption
between those renames fails closed on the next install rather than guessing
ownership. An exclusive `~/.local/bin/.parallels-install.lock` covers the entire
fetch/dependencies/build/install operation, and also manual `install:local` builds.

If installation refuses, inspect the named paths; do not blindly delete or
replace them. A stale lock, missing/mismatched receipt, or interrupted upgrade
needs manual inspection (including confirmation no installer/updater is running).
Preserve/move aside only the verified installation files or stale lock before a
fresh install; never remove `~/.parallels`, auth, config, or projects to resolve
an installation problem. A different existing executable must be preserved or
explicitly moved by you. The receipt and path checks are accidental-overwrite
guards, not a security boundary against another process running as your user.
For a manually chosen reviewed revision, preserve any existing commits first,
select that exact revision in the dedicated app clone, then run
`bun install --frozen-lockfile` and `bun run install:local`; do not build from the
unrelated project you happened to invoke `parallels` in.

### Development

From a development checkout, `bun install --frozen-lockfile` followed by
`bun src/cli.ts` (or `bun src/cli.ts start [project] [directory]`) still works.
`bun run check`, `bun test`, `bun run build`, and `git diff --check` are the local
validation commands. The compiled/installation tests use temporary HOME/state,
relocated executables, fake provider/tmux boundaries and an owned PTY. Updater
tests use temporary local Git remotes and offline dependency/build boundaries,
including an installed standalone invocation from another dirty repository. They
make no live model calls and do not install/update anything in your real home.

## Using the TUI

`start` opens a TUI with one page per orchestrator (one per project). Orchestrator
tabs and project details stay at the top; the input, counts and panels stay at
the bottom. The conversation scrolls between them with Page Up/Page Down or the
mouse wheel. Fullscreen and mouse reporting are always enabled: unmodified left
button drag highlights **committed conversation text** inside the app. Selection
automatically copies on valid drag release (not a mere click). **Ctrl+O re-copies**
the retained highlight explicitly; Esc clears
it without clearing your draft. Cmd-C is owned by macOS/Terminal, not delivered to
the app as a copy key. Ctrl+C still cancels the turn (twice exits).

Highlight survives scrolling and ordinary redraws; wheel while dragging extends
the selection when the next drag report arrives. There is no edge auto-scroll.
Headers, composer, panels, tool activity and unfinished streaming text cannot be
selected. Copy includes displayed gutters and line breaks (including soft wraps),
not original Markdown. Wide characters and combining sequences are selected whole.
Resize/reflow, changing conversation, or replacing selected content clears the
highlight rather than copying stale or unrelated text. Selected rows temporarily
use plain inverse text; clearing restores their styling and links.

Copy uses local `pbcopy` on macOS or an existing `wl-copy`/`xclip` on Linux, with
text on stdin and no shell interpolation. No automatic installation or OSC 52.
SSH and unavailable desktop clipboards report a copy error; no silent fallback.
In Apple Terminal, enable **View > Allow Mouse Reporting** (see
[Apple's mouse reporting guide](https://support.apple.com/guide/terminal/turn-on-mouse-reporting-trmlc69728a5/mac)).
Selection requires SGR drag reports; legacy X10 wheel packets still scroll.
If reporting is disabled by the terminal, the app cannot intercept wheel/drag;
PgUp/PgDn remain available. Native selection and fullscreen mouse reporting do not
automatically coexist. Terminal-specific mouse overrides can bypass the app but
are not the selection/copy workflow described here.

OSC 8 web link targets remain in unselected output, including wrapped links.
Native link gestures depend on the terminal's hyperlink support and mouse override;
Apple Terminal link opening while reporting is **not guaranteed**. The portable
mouse protocol does not identify Cmd, and the app does not guess Cmd-click or launch
a browser. Copied URLs can be opened separately. Protocol/PTY tests do not establish
physical GUI behavior in Apple Terminal.

Only changed screen rows are redrawn. All saved conversation, including original
history before compaction, is reachable inside the app. Quitting restores your
shell and prints the active conversation into its normal scrollback.
The orchestrator's replies are rendered as markdown (headings, emphasis, lists, quotes, code
blocks, links and box-drawn tables that fit the terminal's width, re-laid out
when it is resized). Run it inside a git repository and you get an orchestrator for that
repository: an `orch-xxxx` project referencing the original checkout (reused next time you
start there). With no project named it also reopens every project under
`~/.parallels/projects`. The ruled, pinned header shows bracketed project/display names (the active one
marked `>`), cached model, effort, fast mode, directory and remote, and refreshes
when settings change.
Short terminals collapse header details to keep the input usable. A blank row
separates the conversation (including streaming output) from the entire footer,
above any queued previews. It is omitted below eight terminal rows or when it
would take the last conversation row; input and footer panels keep their space.
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
`/agents` view show calls the same way. Ctrl+N starts a new conversation named `orch-xxxx` in the
original checkout. `/rename <name>` renames it; `/new <name> <directory>` selects
another local checkout (the directory may contain spaces). Ctrl+Z and Ctrl+X move between pages,
reprinting the page you switch to (`/keys` shows what your terminal sends for any chord). Type
`/help` for grouped commands and keyboard shortcuts in a panel below the input
and counts, not in the conversation history. Scroll help with ↑/↓, Page Up/Down
or the wheel; Home/End jumps to its start/end (including advanced diagnostics).
Esc closes it without changing your draft or leaving an agent view. Help is
read-only while open; close it before typing. Global cancellation/page shortcuts
still work, and Ctrl+Q replaces help with the Inbox's Questions section.

`/refresh` reloads **shared local persisted state**: project names/pins/list,
saved conversation/model context, tasks/questions, agent status and model/settings.
It also runs automatically when submitting a prompt, including while busy or
signing in; publication never waits for refresh. Periodic snapshots pick up
consumption in other windows. Drafts/cursors, active page, pinned bars and history
stay intact; disruptive context replacement waits until the local turn is idle.
Refresh does not pull Git changes, update/restart the harness, synchronize laptops,
submit/resend input, run tools or restart agents. Normal inbox processing remains
separate. See [SESSION_REFRESH.md](SESSION_REFRESH.md) for receipt semantics,
concurrency, mixed-version limitations and safe stale-lock recovery.

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
A preview clears only when its exact immutable input ID is committed with model
context, locally or in another updated window; identical text or a missing inbox
file is not evidence. A provider failure after that commit does not resend input.
Older transcripts without receipts cannot retroactively acknowledge previews.
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
"type your own answer" and "skip — remove from inbox". ↑↓ or 1–9 choose and Enter
picks. Typing switches to `answer>`; an optionless question starts there.
Esc, Tab or Ctrl+Q closes the panel without answering or skipping, and restores
your chat draft. The answer draft and cursor are retained across sections, closing and project switches.
Project switches close Inbox; explicitly reopen to resume the answer. Only selecting
"skip" and pressing Enter durably removes that question from Inbox and decrements
the count, keeping its skipped history. Skip sends no message, applies no default
and never wakes/resumes an agent, including paused or cancelled work. Silence and
panel dismissal also never apply a default or grant approval; an optional stored
default is only a suggestion for an explicit answer. New arrivals update the count, not the input.
Answering or skipping the last question closes the panel; a later question needs explicit
opening again. Explicitly opening an empty queue shows No open questions. A half-second guard after opening prevents accidental answers.
Menus take precedence over questions; Ctrl+Q does nothing while a menu/project
list is open. On a one-row terminal the input takes the whole live region: a modal panel
can be hidden while still owning keys; Esc closes it. In an agent view Questions
shows a guard, never an answer field: close Inbox, then Esc or `/back` to the
project orchestrator before answering. Each answer leaves a
dim `? question → answer` line; a skip leaves only a local removed-from-inbox note,
not a delivered reply or model input. Historical delivered skip/default messages
still render as before. Background projects' question counts are shown too.

Harness state lives under `~/.parallels` by default; your checkout and worker
worktrees stay outside it. Design notes are in [PLAN.md](PLAN.md).

## The cycle

The orchestrator shows a plan and answers questions; clear requests authorize only
their scope, while "execute" or "dispatch" alone authorizes the plan last shown.
It spawns a **worker** on a branch; each run ends in one commit and one report,
with local checks proportionate to the actual diff and risk.

Pure wording/formatting in README/docs/comments may go directly to a **reviewer**
in `reviewMode: "watch-ci"` for publication and bounded requested-text/link checks,
with a risk rationale and no code-review round, complexity call or full app suite.
The reviewer inspects the actual diff: behavior, security, config, agent instructions
and executable examples need substantive risk review and relevant checks, even in
Markdown. File extension alone never establishes low risk.

Substantive work uses `reviewMode: "review"`: assess the diff against the task,
without editing code, and use `complexity` for changed JS/TS logic where relevant.
The tool scores all functions in selected files; prefer explicit files and compare
the diff/base before calling scores regressions. Unchanged functions are baseline
context, not new findings merely because a file was touched. Report measured
scores against configured thresholds; unsupported or failed analysis is not zero.
Explain skipped checks briefly, not with an N/A table.

Problems go back to the worker, then review again, for at most `maxReviewRounds`;
if the last review still finds problems, the worker gets one more pass, followed
by watch-ci with no further review, and the user hears what remains. A clean review
also proceeds to watch-ci: push/open the PR, run `gh pr checks --watch`, fix failures
and revalidate. If watch-ci discovers material changes needing review with rounds
enabled, return to the orchestrator before readiness; respect the cap and disclose
any explicitly exhausted-budget exception. Only explicitly tagged review dispatches
count as rounds, not prose or watch-ci validation. Publication or no hosted checks
is not validation: `task ready` needs explicit evidence for the exact clean PR head,
including bounded editorial checks when appropriate. One agent codes on a branch at a
time: spawn waits briefly and then refuses while the branch's worker or reviewer
is still running. Corrections to an existing task or unmerged PR reuse its task ID
and branch, including CI failures, review feedback and user-requested fixes after
a ready report. The orchestrator finds the task with `task list/get` and refreshes
its PR state with `task pr` before resuming. It messages a running agent or
restarts the worker on the same branch, then runs the task flow again. The reviewer
updates the same PR and validates its new head; previous readiness is invalidated.
These corrections need no new task, temporary branch or cherry-pick workaround.
A separate small follow-up before PR publication can reuse the branch with a new
task ID. Independent work, separate work after publication, and work after a merge
get a new branch.

When a branch's PR is merged, the TUI notices within about 30 seconds (it asks
`gh pr list --repo <origin> --state merged` for each open project whose origin
is on GitHub; without `gh` nothing happens): it stops that branch's worker and
reviewer, removes the worktree and the local and remote branch, deletes their
transcripts, and tells the orchestrator, which tells you and starts whatever was
waiting on that branch.
For original-checkout projects, cleanup never pulls or changes that checkout;
update its default branch yourself. Legacy clone-based projects still fast-forward
their managed checkout. The worktree is removed with `git worktree remove --force`,
so ignored files in it, such as `.env`, are deleted too. Everything is kept, and the message says
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

### Orchestrator rolling memory

The orchestrator starts a background `gpt-6-luna` summary at about **100,000 input
tokens**, or earlier if its selected model has a smaller usable context. It keeps
roughly the newest **20,000 tokens verbatim**, including complete tool exchanges.
An oversized newest exchange stays intact. Workers and reviewers keep their
existing compaction behavior.

The summary carries user facts/preferences, standing project decisions, unresolved
questions, unregistered work, and notes for unfinished tasks. A task is finished
only after the registry records a verified merge. Blocked, cancelled and
closed-unmerged tasks stay recorded; their presence never authorizes a restart.
The current task registry is read again before publication, so an in-flight summary
cannot restore stale task notes after a merge or other task update.

One summary worker runs per session. The foreground continues until it needs the reclaimed
space; `/compact` waits explicitly. The summary replaces only the captured older
prefix at a safe tool boundary. Every newer message, including messages arriving
while the worker runs, survives unchanged. The TUI can publish a ready summary
while idle without making another foreground model request. Summary requests have
no tools, use low effort, and split large sources into bounded UTF-8 parts. The
worker has a two-minute deadline and a 30-second automatic retry cooldown.
Closing the page or exiting the TUI cancels its worker. Shared cancellation,
`/clear`, or another session's checkpoint invalidates stale summary work. Refresh
only reloads state and invalidates stale work; it never starts or publishes a
summary. Idle maintenance publishes only work already requested by a turn.

Checkpoint publication holds the project/turn locks, reloads shared history and
conditionally appends against that exact transcript head. Original inbox receipts
survive both checkpoints and clears. The internal one-shot orchestrator command
uses the same turn owner and fresh-input requirement as the TUI, and joins its
outstanding worker before releasing the lock. Saved history or already-consumed
inbox residue alone never starts another model turn.

This requires a configured OpenAI subscription login (`/login openai`) even when
the foreground uses Claude. `compact = false` disables automatic compaction;
`/compact` still requests it. Missing credentials, failed summaries, archive
failures and cancellation preserve the original history. If the resulting input
still cannot fit, the existing context guard stops the model request.

Original entries and task records are indexed in private
`~/.parallels/projects/<project>/memory.sqlite`, using Bun's built-in SQLite and
FTS5. JSONL transcripts and `tasks.json` remain authoritative; the index can be
rebuilt. Inbox delivery and task IDs/status semantics are unchanged. Image IDs and
original prompt associations are searchable; raw archive entries and checkpoints
preserve scoped image references. Text summaries/search do not inspect or return
pixels; normal provider requests still materialize retained images. Accumulated
image limits fail explicitly, never evict images silently. See
[image context/history behavior](IMAGE_ATTACHMENTS.md#context-budgeting-and-integration-contract).

The orchestrator uses the existing `task` tool:

- `search_history` with `query`, optional `status` (`all`, `merged`, `active`),
  `taskId`, and `limit` (default 5, maximum 10) returns task records and excerpts.
- `read_history` with an `entryId` returns up to 2,048 Unicode characters;
  `nextOffset` retrieves the next page.

Task-specific excerpts require an explicit task UUID in the original entry.
Use ordinary text search for conversations without that link. Retrieval is
restricted to the current `/clear` scope; old bytes remain on disk. Retrieved
text and summaries are historical evidence, not new instructions. Summaries are
lossy: check original details when they matter. The active model context stays
bounded, but disk history grows with use; this is not unlimited model context.

### Tool output and scheduling

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

`timeout_ms` sets a command's maximum runtime (1–600000 milliseconds; default
600000 for compatibility). A timeout kills the shell's process group and returns
the output captured so far, marked partial. Use 10000–30000 for connection probes
so a stalled database or network check returns promptly. Commands run
non-interactively with the harness's inherited `PATH`; make sure required clients
such as `psql` are available there, or use their installed absolute path.

For PostgreSQL, the project's query wrapper should set a connection timeout
such as `PGCONNECT_TIMEOUT=10` and a per-session `statement_timeout` appropriate
for its queries. These cover different stages; keep the shell timeout as an
overall deadline. Use non-interactive `psql` options (`-X -w -v ON_ERROR_STOP=1
-P pager=off`) to avoid startup-file surprises, password prompts and paging,
and to report SQL errors as failures. See PostgreSQL's
[connection environment variables](https://www.postgresql.org/docs/current/libpq-envars.html),
[statement timeouts](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-STATEMENT-TIMEOUT),
and [psql options](https://www.postgresql.org/docs/current/app-psql.html).
Timeouts bound the wait; missing clients and server/tunnel failures still need
to be diagnosed in the project environment.

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
Small Tasks/Questions tabs show one compact section at a time. Status is exactly
one plain label: stored attention (waiting/blocked/cancelled/closed/unknown) takes
precedence over lifecycle (queued/working/reviewing/ready to merge). No extra
status detail or reason appears under a task; stored lifecycle, attention and
reason remain unchanged. Global loading/query-error/stale warnings stay explicit;
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
