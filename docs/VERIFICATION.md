# Disposable verification sessions

The `sandbox` tool owns a temporary environment, supervised commands, and an
artifact directory. Use the same session for reproduction, implementation
checks, UI interaction, screenshots, recordings, and API evidence. Skills and
installed platform tools supply the workflow.

`create` takes `backend: "local"` or `"docker"`. The workspace snapshots the
current Git checkout, tracked edits, and up to 32 MiB of untracked source. Ignored
dependencies are excluded. Docker uses an already available image with `sh` and
binds the disposable workspace and retained artifacts. Requested ports publish
on random localhost ports. Shared Git objects are mounted read-only. The Docker
host must be able to mount the session directories. Local sessions support
native applications. A `simulator` with `deviceType` and `runtime` creates and
boots a device in a private macOS simulator set.

`run` accepts a shell command and returns the existing supervised process handle.
Completion arrives through the existing inbox with exit status and output. Run
apps via their foreground executable so the supervisor owns their process group.
Use `process` to inspect output or stop a command. `ORCA_ARTIFACTS` points to the
retained evidence directory. Local temporary files and XDG caches use disposable
session storage. Configure other tool-specific caches in that directory too.

For browser and Linux desktop testing, select an image with the test/browser
and recording tools installed, or install tooling inside the disposable
container. Playwright, WebDriver, agent-browser, ffmpeg, and API clients can be
run through the same command path. App-specific interaction and assertions stay
in the repository's tests and skills.

`capture` saves a named artifact. Its explicit `command` receives
`ORCA_CAPTURE_PATH`. On macOS it also supports `target: "desktop"` and
`target: "ios"` with the session's private simulator. Omit `seconds` for a
screenshot, or provide 1–120 seconds for video. Desktop capture uses macOS screen
recording permissions. iOS requires Xcode and an installed runtime. A capture
that exits successfully without a nonempty artifact is reported as failed.
Artifacts can be inspected with `read` or platform media tools. File creation
alone does not establish that a behavior works.

`status` returns the session and artifact locations. `list` shows the caller's
sessions, or the project's sessions for the orchestrator. `close` stops owned
commands, finalizes recording where possible, removes the owned container and
its anonymous volumes, deletes the private simulator set and temporary checkout,
and retains patches and untracked source changes as evidence. Cleanup failures
remain recorded and retryable. Cross-run worker control is refused.

Workers close idle sessions on exit, orchestrators close idle sessions at turn
completion, and conversation cancellation triggers cleanup. Existing runtime
recovery also handles expired sessions, orphaned owners, and failed cleanup.
A machine or daemon shutdown can defer recovery until Orca runs again. Defaults
are four active sessions per conversation, a 60-minute session lifetime (up to
six hours), and 2 CPUs/2 GiB per container. Capture commands and tests keep their
own outcome evidence. Closed-session evidence is retained for seven days within
a 1 GiB budget per conversation; active sessions are excluded from retention.

# Storage maintenance

`orca clean` or `orca clean --dry-run` inspects disposable storage.
`orca clean --apply` applies eligible cleanup. The existing daemon maintenance
pass also cleans merged worker worktrees and old settled process output.

A worker checkout is eligible only when its recorded PR is merged, its HEAD
matches the merged PR, every known owner is verified exited, no instructions are
queued, and there are no source edits or untracked files. Only recognized ignored
build directories qualify for removal. The branch launch lock prevents a new
assignment racing cleanup. Local branches and transcripts remain available.
Ambiguous processes and unknown ignored files are retained and reported.

Settled process logs have a seven-day/1 GiB retention budget. Undelivered events,
active processes, and unknown processes are preserved. Pull also prunes old Bun
scratch executables after `lsof` confirms no open handles. User research clones,
shared Docker images, named volumes, and caches outside owned sessions need an
explicit ownership decision. There is no global Docker or simulator prune.
