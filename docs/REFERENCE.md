# orca reference

### Upgrading to orca

The command, package, compiled executable and visible branding are now `orca`.
New installations use `~/.orca`, `ORCA_HOME`, and `.orca-worktrees` beside the
original checkout. The whale in the header uses your terminal's available space:
a detailed silhouette in tall terminals, compact artwork beside metadata in
ordinary terminals, and metadata alone when space is tight. Only the selected
working conversation animates; idle headers stay still. Artwork never enters
model context or saved conversation history.

Finish active runs before upgrading, including background workers and each
project's orchestrator daemon (the `orchestrator` window of `orca-<project>`;
it keeps running after the TUI closes): new tmux sessions use the `orca-` prefix. From your updated harness checkout, run
`bun run install:local` once to install `~/.local/bin/orca`, then use `orca`.
The installer leaves the old executable and its receipt in place, rather than
overwriting an unrelated command or changing a running process.

Existing data stays readable without moving it. `ORCA_HOME` takes precedence;
the old `PARALLELS_HOME` override still works. Without an override, established
state in `~/.orca` wins; otherwise an existing `~/.parallels` is reused, including
saved accounts and conversations. Creating only `~/.orca/app` does not hide old
state. Set `ORCA_HOME` explicitly if you keep two separate state stores. Existing
worker worktrees retain their registered paths, and old saved image references
remain valid. There is no automatic migration or deletion.

`orca pull` also supports an existing dedicated `~/.parallels/app` checkout when
`~/.orca/app` is absent. Builds include a compatibility output for an already
running old updater, so it receives the new binary instead of a stale build;
the one-time install above supplies the new `orca` command. The verified GitHub
origin is still `https://github.com/wabarurse/parallels.git`; renaming the product
does not rename the hosted repository. Historical evaluation evidence retains
its original names and paths.

[Getting started](../README.md) · [Documentation index](README.md)

Repository file paths in this guide are relative to the repository root.

orca is a terminal app that helps you work on a Git repository with AI agents.
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

After installing the prerequisites above, run:

```sh
curl -fsSL https://raw.githubusercontent.com/wabarurse/parallels/main/install.sh | sh
```

The installer clones the app's `main` branch into `~/.orca/app`, installs frozen
dependencies, builds it, and installs `~/.local/bin/orca`. It adds the PATH entry
to `.bashrc` for bash, `.zshrc` (respecting `ZDOTDIR`) for zsh, or `.profile` for
sh. Unsupported shells and unsafe startup files get manual instructions.
Use `| sh -s -- --no-modify-path` to leave shell files alone. Open a new terminal
afterward, or run the PATH command printed by the installer for this terminal.
Git, Bun, and tmux must already be installed; it does not use sudo.

To inspect before running, download instead of piping:

```sh
curl -fsSL https://raw.githubusercontent.com/wabarurse/parallels/main/install.sh -o install.sh
# Read install.sh, then:
sh install.sh
```

Existing config, auth, projects and repositories stay in place. Creating the
app directory alone does not hide existing `.parallels` state. `ORCA_HOME` and
the legacy override continue to select runtime state independently of the app.
Future updates use `orca pull`. An existing app is never overwritten by the
bootstrap; for failed or partial installs, see
[ownership and recovery](#installer-ownership-and-recovery).

Alternatively, install manually without changing shell files:

```sh
(
  set -eu
  umask 022
  # Never replace an existing app or follow a symlink into unrelated content.
  if [ -L "$HOME/.orca" ] || [ -e "$HOME/.orca/app" ] || [ -L "$HOME/.orca/app" ]; then
    echo "Existing app or symlink: inspect it first; use the update steps for your own clone." >&2
    exit 1
  fi
  mkdir -p "$HOME/.orca"
  git clone https://github.com/wabarurse/parallels.git "$HOME/.orca/app"
  cd "$HOME/.orca/app"
  # To install an exact reviewed revision, first: git switch --detach <reviewed-commit>
  bun install --frozen-lockfile
  bun run install:local
)
```

For this shell session, make the executable available and check which one runs:

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v orca
orca version
```

For a permanent PATH change, see [installation details](#install-once-run-from-any-repository).
You can also use `"$HOME/.local/bin/orca"` directly.

### 3. Open your repository and sign in

In your shell, go to an existing local repository. Check `git status` and resolve
local work before switching to its default branch (`main` below; substitute your
repository's default branch if different). orca will not switch or stash for you.

```sh
cd /path/to/your/repository
git status --short
git switch main
orca
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

- `/help` shows commands and shortcuts; Esc closes it. `orca --help` shows
  shell commands outside the TUI.
- `/agents` lists agents to attach to, each with a clock for its latest run:
  `worker-foo  live 3m 12s` (bold, ticking once a second) while its tmux window
  is open, `worker-foo  finished 14m 02s` (dim, final) after. Times read
  `59s`, `3m 12s`, `1h 04m`, `2d 3h`. An agent that reported but whose window is
  still open counts as running. An agent killed hard (no recorded end) shows
  `~` and ends at the run state's last update; an agent started before clocks
  existed starts at its first transcript entry. A respawn on the same branch
  restarts the clock. The attached view's header has no clock. `/back` returns to
  the orchestrator. `/inbox` shows registered tasks, and `/questions` (or Ctrl+Q) opens questions needing answers.
- Ctrl+C cancels the current turn; `/quit` exits. The orchestrator daemon and
  background workers/reviewers keep running; see [Using the TUI](#using-the-tui)
  for cancellation details.
- Finish active work and let background agents exit, including the orchestrator
  daemons (`orca stop <project>` for each, or delete the project), then run `orca pull`
  from any directory to update **only the dedicated app installation**. Git and
  Bun 1.4.2+ are required. Restart afterward; existing processes are not upgraded.
  Read [update safety and recovery](#explicit-updates-orca-pull) before updating.

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

Keep the harness checkout separate from the repositories you work on. Both the
bootstrap and manual workflow install the app at `~/.orca/app` and the executable
at `~/.local/bin/orca`.

Follow the [quick-start installation steps](#2-install-once) above.

`install:local` builds `dist/orca` from that checkout, then copies it to
`$HOME/.local/bin/orca` with executable permissions. It works even when
invoked by an absolute script path from another directory. It never replaces
`~/.orca` itself, changes auth/config/projects, moves your repositories, or
edits shell startup files. `ORCA_HOME` still relocates **runtime state**;
it does not change the app checkout or executable installation destination.

If `~/.local/bin` is not on your PATH, for the current sh/bash/zsh session use:

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v orca
orca version
```

The bootstrap adds that export for supported shells. After a manual install or
`--no-modify-path`, add it to your shell startup file yourself, or use your shell's
equivalent (e.g. `fish_add_path ~/.local/bin` in fish).
Check `command -v orca` for another executable shadowing this
one. You can always invoke `"$HOME/.local/bin/orca"` directly.

```sh
cd /path/to/any/repository
orca
# Equivalent explicit form; optional project and local directory:
orca start [project] [directory]
orca msg <project> <text>
orca version
orca --help
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
`<checkout>.orca-worktrees/<worktree-id>/<branch-slug>`. Reviewers reuse
the worker's worktree. These share Git objects and repository-local config with
the original checkout, including later login updates. Worktrees do not contain
the original's uncommitted changes or untracked/ignored files such as `.env`;
project setup must provision files needed in each worktree. New agents inherit
the launch process's exported environment (HOME, PATH, auth variables and agent
sockets), even when tmux was started with older values. Private temporary
environment handoffs delete themselves before starting the agent; values are
not placed in command arguments or tmux options. This does not transfer browser
sessions or logins in a different OS account/container.

The orchestrator itself is a long-lived process too: `orca start` makes sure
each open project's **orchestrator daemon** runs in the `orchestrator` window
of that project's tmux session and starts it when it is not (you see
`orchestrator started` on the page). The TUI is a client: your messages go to
the daemon's inbox, Ctrl+C, `/clear`, `/compact` and `/models` go to it as
file requests it acknowledges on the page, and the conversation is read back
from the saved transcript as the daemon appends to it. Closing the TUI (or your
terminal) leaves the orchestrator's turn, its background workers, the exit
watchdog and merge cleanup running; the next `orca start` attaches to them
again. The page shows a `thinking…` indicator while a daemon turn runs and each
completed reply or tool line as it lands; partial text is not streamed. A
daemon that crashes leaves an `[agent-exit] orchestrator …` notice for its
successor and is restarted by the next TUI poll (`orchestrator was not running;
restarted`); `tmux -S ~/.orca/tmux.sock attach -t orca-<project>` shows its
window. Only one daemon runs per project: a second start finds the first. `orca stop
<project>` stops a daemon cleanly (it asks, waits up to 10s, then kills the
window): nothing is lost, queued input waits for the next start, and no notice
is sent. A daemon killed by a signal instead (its window closed by hand, `tmux
kill-server`, a logout) writes an `[agent-exit] orchestrator killed by SIGHUP …`
notice into its own inbox, which the next daemon reads as its first message.

Agents run on **orca's own tmux server**, never your default one: its socket is
`$ORCA_HOME/tmux.sock` (`tmux -S ~/.orca/tmux.sock list-windows -t orca-<project>`
lists a project's agent windows and `tmux -S ~/.orca/tmux.sock attach -t orca-<project>`
attaches to them; `tmux -L orca` replaces `-S …` when the state path is too long
for a socket). A stale default server, started days earlier from a directory that
has since moved or been deleted, opens every window with a broken working
directory, and the agents in them die before they start; orca's server is
started from the state directory, which outlives any checkout. Each spawn still
checks that the server can run commands and, if it cannot, fails with the
`tmux -S … kill-server` command that stops it (and every agent on it). A spawn
then waits a few seconds for the agent to come up (its run record; a slow start
still passes): a window that dies first fails the spawn with the pane's last
output, the dead pane is removed and the task run is recorded as failed (launch
failed), so the orchestrator learns about it from the tool result rather than
from nothing, and from nothing else: that death gets no second `[agent-exit]`
notice. If an agent dies before writing its run record later than that, the
orchestrator daemon's watchdog sends one `[agent-exit] <agent> never started; task "<name>" needs
reconciliation` notice about 30 seconds after the launch. Agents started by an
earlier orca version keep running on your default tmux server; let them report,
or kill their windows there (`tmux kill-window -t orca-<project>:<agent>`).

`$ORCA_HOME/projects` (default `~/.orca/projects`) stores conversations,
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

### Explicit updates: `orca pull`

Finish active work and let background agents exit before upgrading. From **any**
directory (including an unrelated repository), run:

```sh
orca pull
# Or, if another command shadows it:
"$HOME/.local/bin/orca" pull
```

This command accepts no arguments. It updates **only the dedicated harness
installation** at `$HOME/.orca/app`, never the invoking repository or a
managed project. `ORCA_HOME` still relocates runtime state, not the updater's
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

Updater subprocesses add `022` to the caller's umask, so Git, dependencies, and
builds do not create group/world-writable paths that fail the next safety check.
A stricter mask such as `077` stays strict, and the caller's umask is unchanged.
Existing unsafe permissions still require inspection; the updater does not
automatically chmod files to bypass ownership checks.

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
error, preserve any local work, resolve it, then rerun `orca pull`. Do not
blindly delete files to make the check pass. A failed build does not require
resetting the checkout.

**Existing processes keep the code they already loaded.** Nothing is stopped,
killed or restarted. New launches use the replacement executable; an old
worker/reviewer shell wrapper can also re-enter that new executable for its
`agent-exit` follow-up. Mixed protocol/code versions are therefore possible if
you update during a run: update **between active runs**, then start a new session
when ready. Source-development processes are not upgraded in place either.

### Installer ownership and recovery

Both `install:local` and `pull` refuse unrelated existing `orca` files,
symlinks (including dangling links and symlinked `.local` / `bin` directories),
directories at file destinations, and files not owned by you or writable by
other users. Neither modifies shell startup files or auth/config/projects.
The installer records the binary's SHA-256 in
`~/.local/bin/.orca-install.json`; keep this receipt alongside the executable.
An upgrade is permitted only when the current executable matches that receipt.
The binary is staged on the same filesystem and replaced with one atomic rename,
so build/copy failure leaves the previous executable intact and an already-open
executable is not truncated. The receipt is published separately **before** the
final binary rename (and restored if that rename fails). Abrupt interruption
between those renames fails closed on the next install rather than guessing
ownership. An exclusive `~/.local/bin/.orca-install.lock` covers the entire
fetch/dependencies/build/install operation, and also manual `install:local` builds.

If installation refuses, inspect the named paths; do not blindly delete or
replace them. A stale lock, missing/mismatched receipt, or interrupted upgrade
needs manual inspection (including confirmation no installer/updater is running).
Preserve/move aside only the verified installation files or stale lock before a
fresh install; never remove `~/.orca`, auth, config, or projects to resolve
an installation problem. A different existing executable must be preserved or
explicitly moved by you. The receipt and path checks are accidental-overwrite
guards, not a security boundary against another process running as your user.
For a manually chosen reviewed revision, preserve any existing commits first,
select that exact revision in the dedicated app clone, then run
`bun install --frozen-lockfile` and `bun run install:local`; do not build from the
unrelated project you happened to invoke `orca` in.

If the bootstrap stopped after cloning, inspect `~/.orca/app` before retrying.
For your verified clean clone of the official repository, resume with:

```sh
(
  set -eu
  umask 022
  cd "$HOME/.orca/app"
  bun install --frozen-lockfile
  bun run install:local
)
export PATH="$HOME/.local/bin:$PATH"
```

The resume command leaves shell files alone. Add the PATH entry yourself if
needed; do not delete saved state to retry installation.

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
`~/.orca/projects`. The ruled, pinned header shows bracketed project/display names (the active one
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
and running tools) by a request the orchestrator daemon picks up within about
100ms while a turn runs (when idle, on its next pass: at once on the file
change, at most a second later) and acknowledges on the page, without closing
the harness or clearing your draft/history.
Other projects' turns and background workers/reviewers keep running. The cancelled
orchestrator stays paused even if agent reports arrive; your next chat message
resumes its saved conversation. While viewing a subagent, Ctrl+C instead stops
only that worker/reviewer, preserving its transcript and worktree; the existing
`spawn` continuation path can restart it with that conversation. Agent views remain
read-only (`/back` to talk to the orchestrator). A hint appears on the first press;
a second Ctrl+C within two seconds exits the harness (`/quit` also exits). Exiting
leaves the orchestrator daemon, its current turn and background agents alone.

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

Harness state lives under `~/.orca` by default; your checkout and worker
worktrees stay outside it. Design notes are in [PLAN.md](PLAN.md).

## The cycle

The orchestrator shows its plan; a clear request to implement authorizes that scope.
It spawns a **worker** on a branch to implement the request and run only relevant
checks. Each worker run ends in one commit and one report, including the check
commands, tested commit/code state, results and saved failure-output paths.
Never run the full test suite, baseline comparisons or duplicate tests. A check
runs once for the code it covers; feedback permits a rerun only when that code
changes. Unchanged passing results carry forward; unchanged failures are reported,
not retried. Missing evidence is reported rather than triggering broader checks.

The **reviewer** reads the diff against the request, inspects failed-check output
and runs `complexity` (cyclomatic and cognitive, per function). It never runs tests
or validation commands, investigates passing checks again, or edits code. Feedback
goes to the worker for changes and relevant checks; subsequent reviews focus on
the new diff and prior findings. This repeats for at most `maxReviewRounds` rounds.
Unresolved findings at the limit are reported without claiming readiness.

After approval, "watch ci" publishes the PR and observes hosted checks with
`gh pr checks --watch`. It reuses worker evidence matched to the current PR head,
never reruns jobs or adds a final local validation pass. Failures return to the
worker through the orchestrator; missing or stale evidence prevents readiness.
With no hosted checks, existing worker evidence still has to establish readiness.
These are role/dispatch instructions, not a shell-command sandbox or a durable
check-result cache. One agent codes on a branch at a
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

orca always connects as **Claude Code** for Claude models and **Codex** for
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
an old `~/.orca/credentials.json` are never used. There is no API-key prompt,
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
Imports do not modify either CLI's original store. Browser login gives orca
independent refresh tokens when you also use the native CLI concurrently.

Browser login requires a browser on the same machine: Claude receives its callback
on `localhost:53692`, Codex on `localhost:1455`. `/quit` cancels a pending login.

The login prints a short link, `http://localhost:<port>/login/<nonce>` (about 45
characters, so it survives terminal wrapping and copying). The loopback server
answers that one random path with a 302 to the full authorize URL; every other path
except the OAuth callback is a 404. The browser is opened with the full URL. Over
SSH (`SSH_CONNECTION` or `SSH_TTY` set) it also prints an `ssh -L` tunnel hint, since
the link and the callback only exist on the machine running orca. If the short
link does not work, the full URL is in `$ORCA_HOME/login-url.txt` (0600; the
message prints only its path). The file is deleted when the login finishes, fails or
is cancelled.
Credentials live under `~/.orca/auth/{anthropic,openai}/` in private (0600)
files with atomic writes and a per-profile lock shared across workers.
`ORCA_HOME` relocates orca' state. Failed login and refresh attempts
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

The orchestrator starts a background `gpt-6-luna` summary at about **40% of the
selected model's context window** (roughly 400,000 input tokens on a 1M-context
model, 80,000 on a 200k model), capped lower when the usable context after the
output reserve is smaller. It keeps
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
survive both checkpoints and clears. The orchestrator daemon owns the turn and
keeps the rolling worker alive between turns; its idle maintenance publishes
work already requested, and the compiled one-shot probe joins its outstanding
worker before exiting. Saved history or already-consumed
inbox residue alone never starts another model turn.

This requires a configured OpenAI subscription login (`/login openai`) even when
the foreground uses Claude. `compact = false` disables automatic compaction;
`/compact` still requests it. Missing credentials, failed summaries, archive
failures and cancellation preserve the original history. If the resulting input
still cannot fit, the existing context guard stops the model request.

Original orchestrator entries and task records are indexed in one private,
global `memory.sqlite` in the state directory (`~/.orca` by default; mode `0600`, as are its `-wal`/`-shm` files),
using Bun's built-in SQLite and FTS5. Every project shares the file: `entries`
carry `project` and `agent` columns (`agent` is always `orchestrator`; worker and
reviewer transcripts are never indexed and have no database access), `tasks`
are keyed by `(project, id)` and carry nullable ISO `started_at`/`ended_at`
derived from the registry record (`started_at`: the earliest confirmed run
start, so prepared or failed launches leave it NULL; `ended_at`: the confirmed
`mergedAt` of an archived task, the registry's only terminal state — cancelled,
closed or blocked attention is revocable, so such tasks stay active with
`ended_at` NULL), and `entry_tasks`, `sources` (per-project `indexed_through`)
and `meta` complete the schema (`PRAGMA user_version = 2`; a version-1 file
gains the two columns in place on open, filled from each row's `raw` record).
The file runs in WAL mode with a long busy timeout; writers use
`BEGIN IMMEDIATE` transactions, so several orchestrators can index concurrently.

JSONL transcripts and `tasks.json` remain authoritative and the index is
rebuildable: deleting `memory.sqlite` (with its `-wal`/`-shm`) loses nothing, and
the next archive, query or startup backfill re-creates it from the transcripts.
Indexing happens at compaction, `/clear`, query time and at the end of each
orchestrator turn. Turn-end (and `/clear`) indexing is best effort: it is bounded
(the whole operation, including waiting for the project lock, is abandoned after
about 3 seconds, and SQLite waits are capped at 1 second), it may therefore skip,
and it only reports a problem; it never fails or meaningfully delays the turn.
The next archive catches up. Large inserts are committed in batches of 200 entries
with the event loop yielded in between. Reading a
project's transcript and registry still happens under that project's state lock
and identity check. Inbox delivery and task IDs/status semantics are unchanged.
Image IDs and original prompt associations are searchable; raw archive entries and
checkpoints preserve scoped image references. Text summaries/search do not inspect
or return pixels; normal provider requests still materialize retained images.
Accumulated image limits fail explicitly, never evict images silently. See
[image context/history behavior](IMAGE_ATTACHMENTS.md#context-budgeting-and-integration-contract).

**Migration from per-project files.** Earlier versions kept
`projects/<project>/memory.sqlite` in the state directory (see above: `~/.orca`, or an
existing `~/.parallels` that is reused; the global file lives in the same directory). When the global file is first
created, or lacks `meta.backfill_version`, the orchestrator starts a resumable
background backfill that never blocks startup (failures are reported and
retried on a later start). Per project, under its state lock, it re-indexes the
full orchestrator transcript (including history before clears) and `tasks.json`
in batched, resumable transactions, then **verifies** by reading the global database back: every
transcript entry must be present with identical body, raw record and epoch,
counts must match, no old-index entry may be missing from the result, and every
task must be present at its revision or newer. Only after that passes are the
project's old `memory.sqlite` and its `-wal`, `-shm` and `-journal` files
deleted. If indexing or verification fails or is partial, the transcript or
`tasks.json` cannot be read, or the old file cannot be copied or read (I/O,
busy, permission errors), nothing is deleted for that project; it is logged and
retried later. Only an old file that is empty or clearly not a SQLite database
(`SQLITE_NOTADB`/`SQLITE_CORRUPT`) counts as having nothing to preserve, and even
then only after the rebuild above verified. Completion is recorded per project
in `meta`. The backfill stops (between projects and batches, releasing its
project locks) when the sessions that started it are disposed, and a later start
resumes. A project that keeps failing is re-indexed on each start; this is
bounded work and is not skipped.

Once `meta.backfill_version` is set the migration is not repeated: an old
per-project `memory.sqlite` that reappears afterwards (restore from backup,
running an older build) is not migrated or deleted, and can be removed by hand.

**Orphan cleanup** runs on every start, independent of the migration: rows (and
backfill marks) of projects whose folder no longer exists are purged, covering a
failed purge at project delete and a project re-indexed by another process just
after its deletion.

Deleting a project purges its rows from the global database (entries, tasks,
links, sources and FTS postings) on a best-effort basis; a failure never blocks
the deletion, and the orphan cleanup at the next start removes any leftovers.

The orchestrator uses the existing `task` tool:

- `search_history` with `query`, optional `status` (`all`, `merged`, `active`),
  `taskId`, and `limit` (default 5, maximum 10) returns task records and excerpts.
- `read_history` with an `entryId` returns up to 2,048 Unicode characters;
  `nextOffset` retrieves the next page.

Task-specific excerpts require an explicit task UUID in the original entry.
Use ordinary text search for conversations without that link. Retrieval is
restricted to this project, the orchestrator's own entries and the current
`/clear` scope (the shared database holds other projects' rows, which never match);
old bytes remain on disk. Result sets, scope and shape are identical to the
per-project archive. Two consequences of sharing one index: `bm25` ranking now
uses statistics of the whole shared index, so the ordering among hits can differ
slightly (single-term queries keep their order); and FTS `MATCH` ranks across all
projects before the project, agent and epoch filter applies, so very common terms
get slower as the archive grows. Retrieved
text and summaries are historical evidence, not new instructions. Summaries are
lossy: check original details when they matter. The active model context stays
bounded, but disk history grows with use; this is not unlimited model context.

### The `history` tool (orchestrator only)

`history` searches the whole global archive, outside the current session. It is
registered for the orchestrator alone (`toolsFor.orchestrator`): workers and
reviewers neither receive the tool nor open the database, their prompts do not
mention it, and `run()` refuses any other role as defense in depth. Only
orchestrator transcripts are indexed.

- `search` with `query` (literal terms, at most 256 characters; no SQL or FTS
  syntax, always bound as parameters), optional `project` filter, `status`
  (`all`, `merged`, `active`), `taskId` and `limit` (default 5, maximum 10).
  Entry hits carry `project`, `agent`, `ts`, `entryId` and an excerpt of at most
  400 characters; task hits carry `project`, `id`, `name`, `summary`, `branch`,
  `status`, `pr` and `attention`.
- `read` with `project` and `entryId` (and optional `offset`) returns a
  2,048-character page and `nextOffset`, like `read_history`.

**Scope.** `/clear` only clears the agent's model context, not the database, so
`history` crosses `/clear` boundaries and project boundaries: every project, every
epoch, `agent = orchestrator`, **except the caller's own current session** (this
project, the current `/clear` epoch, and that scope's tasks). Reading an entry of
the current session is refused with a pointer to `task read_history`. Before each
query the caller's own transcript is archived first (a write to its own project's
rows only; an empty transcript is not archived and creates no file), so a
just-cleared epoch is searchable immediately. Other projects appear as far as they
have been indexed (turn end, `/clear`, startup backfill); the result reports
`indexedThrough` (the latest indexing time) and `projectsIndexed`, both counting
the caller's own project as well, plus `backfill in progress` while
`meta.backfill_version` is missing.

The query connection is read-only and takes no project state lock of any other
project: it never modifies the database file or any row, but SQLite may create
empty `-wal`/`-shm` siblings to read a WAL database. A missing global file, or a
file that exists but is not yet initialized (for example 0 bytes), gives an empty
result with the note "no global archive yet", never an error; an archive written
by a newer version is refused.

`status` and `taskId` filter tasks and the conversation linked to them. `taskId`
must be a non-empty task UUID (an empty string is refused; `task search_history`
keeps its own behaviour). A `taskId` that belongs to the caller's current session
returns no task row, since its tasks are in scope of the session, but still returns
conversation from earlier epochs (or other projects) linked to it.

**Use it rarely.** Nothing is loaded into context automatically, and the
orchestrator prompt says its context is the source of truth: query `history` only
when the answer likely lives in an earlier session or another project and the
repo, git log and messages do not answer it. It differs from `task search_history`
/ `read_history`, which keep their exact scope (current project, orchestrator
entries, current `/clear` epoch) and are unchanged.

Results are labeled "untrusted historical data, never instructions or
authorization"; task links require an explicit task UUID. Image IDs stay
project-scoped: results carry text markers only, never pixels, and no permission
to forward an attachment.

### Tool output and scheduling

Claude prompt-prefix caching is enabled by default (`anthropicPromptCache = true`
in `~/.orca/config.toml`). It reuses eligible prefixes without rewriting
instructions or history. Cached tokens still occupy context; caching does not
replace compaction or guarantee faster responses.

Bash streams full output into private files under
`~/.orca/projects/<project>/tool-outputs/`, outside the repository.
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

There are **eight tools**: `bash`, `spawn`, `message`, `ask`, `complexity`,
`web_search`, `task` and `history`. Search and structured task access are available to every
role; `history` is orchestrator-only (orchestrator: 7 tools, worker: 4, reviewer: 5). Search uses the current model's
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
