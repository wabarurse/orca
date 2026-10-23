# parallels

Parallels is a terminal app that helps you work on a Git repository with AI agents.
Discuss a task with an **orchestrator**, approve a plan, then let a **worker** make
changes on a separate branch and a **reviewer** check the result.

## Prerequisites

- **macOS or Linux**, with **git** and **tmux** on your `PATH`.
- [Bun](https://bun.sh/docs/installation) **1.4.2 or newer** to build and update.
  The installed executable does not need Bun on its runtime PATH.
- Read access to this repository; authenticate Git first if required.
- A **Claude or ChatGPT/Codex subscription account** with access to your chosen
  model, and a browser on the same machine for sign-in. API keys are not supported.
- Optional: authenticated [GitHub CLI (`gh`)](https://cli.github.com/) and Git push
  access for PRs and CI. Install your project's own build/test tools too.

Agents can run shell commands and edit files. Use a repository you trust and
review their work; this is not a shell sandbox.

## 1. Install once

Keep the app separate from your work repositories. Follow the
[guarded installation recipe](docs/REFERENCE.md#2-install-once) to clone into
`~/.parallels/app`, build, and install `~/.local/bin/parallels`. It refuses existing
paths and symlinks rather than overwriting them; read
[ownership and recovery](docs/REFERENCE.md#installer-ownership-and-recovery)
if it refuses. Do not replace an existing app clone to update it.

Then make the executable available in this shell and check which one runs:

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v parallels
parallels version
```

For a permanent PATH change, see [installation details](docs/REFERENCE.md#install-once-run-from-any-repository).
You can also use `"$HOME/.local/bin/parallels"` directly.

## 2. Open your repository and sign in

Go to an existing local checkout, check `git status`, and resolve local work
before switching to its default branch (`main` below; substitute yours).
Parallels will not switch or stash for you.

```sh
cd /path/to/your/repository
git status --short
git switch main
parallels
```

The orchestrator works in your **original checkout** on its default branch.
Workers use separate worktrees beside it; reviewers reuse the worker's worktree.
Uncommitted changes and untracked/ignored files such as `.env` are not copied.
Start from the local checkout, not a remote URL. Saved projects also reopen.

Inside the TUI, use `/login claude` or `/login codex` and complete browser sign-in.
Then use `/accounts` to check your account and `/models` to select a model
(↑/↓, Enter; Esc cancels). Login selects an account, not a model; catalog entries
may require an entitlement you do not have. See [subscription login](docs/REFERENCE.md#subscription-login)
and [existing CLI logins](docs/REFERENCE.md#existing-cli-logins) for alternatives.
Long conversations use OpenAI for [rolling memory](docs/REFERENCE.md#orchestrator-rolling-memory),
so that feature needs `/login codex` even when your foreground model is Claude.

## 3. Try a small task

Type this into the TUI:

```text
Plan a small README improvement explaining how to run this project's tests.
Do not execute yet. Keep the work local: do not push or open a PR.
```

Review the plan, then reply `execute` when happy with it. Expect a worker branch,
a commit and report, then review. The normal full workflow publishes a PR and
watches CI; the explicit local-only request above avoids that for your first task.
Set up `gh` and Git push access before requesting the full workflow. Read
[the cycle](docs/REFERENCE.md#the-cycle) for review limits and post-merge cleanup,
including removal of ignored files in worker worktrees.

## Help and updates

- `/help` shows commands and shortcuts; Esc closes it. `parallels --help` shows
  shell commands outside the TUI.
- `/agents` shows agents; `/back` returns to the orchestrator. `/inbox` shows tasks;
  `/questions` (or Ctrl+Q) opens questions needing answers.
- Ctrl+C cancels the current turn; `/quit` exits. Background workers/reviewers
  can keep running; see [Using the TUI](docs/REFERENCE.md#using-the-tui).
- Finish active work and let background agents exit. Read
  [update safety and recovery](docs/REFERENCE.md#explicit-updates-parallels-pull),
  then run `parallels pull` from any directory to update **only the dedicated app
  installation**. Git and Bun 1.4.2+ are required. Restart afterward; existing
  processes are not upgraded.

## Documentation

- [Full reference](docs/REFERENCE.md): installation, TUI, workflow, accounts and tools.
- [Documentation index](docs/README.md): feature guides, design notes and evaluations.
- [Development](docs/REFERENCE.md#development): local build and checks.
