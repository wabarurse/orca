# Disposable verification sessions

The `sandbox` tool owns a temporary environment, supervised commands, and an
artifact directory. Use the same session for reproduction, implementation
checks, UI interaction, screenshots, recordings, and API evidence. Skills and
installed platform tools supply the workflow.

`create` takes `backend: "local"` or `"docker"`. The workspace snapshots the
current Git checkout, tracked edits, and up to 32 MiB of untracked source. Without
Git it copies the current directory, bounded to 256 MiB and 20,000 entries;
links and special files are refused, and `.git`, `node_modules`, `.venv`,
`__pycache__`, `.cache`, `.next`, and `.orca-tmp` are excluded. Closing retains a
`directory-result` copy before discarding the workspace; failed archival retains
the session for recovery. Git snapshots exclude ignored dependencies.
Docker uses an already available image with `sh` and
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
own outcome evidence. Workspace-owned evidence stays available until its
workspace is archived and explicitly cleaned. Legacy unowned evidence retains
its seven-day/1 GiB policy until discovery associates it with a workspace.

# Storage maintenance

`orca clean` or `orca clean --dry-run` inspects disposable storage.
`orca clean --apply` removes eligible archived workspaces and their owned
records, transcripts and unreferenced images/evidence. The existing maintenance
pass archives workspaces after 14 inactive days; it does not delete them.
Individual view archives remain presentation only. See
[workspace cleanup](WORKSPACE_CLEANUP.md) for ownership and recovery details.

A disposable worker checkout needs no task or merged PR, but every owner must be
inactive with no queued work. Source edits, untracked files and unknown ignored
files prevent checkout deletion; recognized ignored build files can be reclaimed
independently. Local branches remain. Shared resources and retained references
are preserved. Cleanup never stops a running environment to make it eligible.

Workspace-owned settled process logs follow the same archive/clean lifecycle;
legacy unowned logs retain the seven-day/1 GiB budget. Undelivered events and
unverified process liveness block cleanup. Pull also prunes old Bun
scratch executables after `lsof` confirms no open handles. User research clones,
shared Docker images, named volumes, and caches outside owned sessions need an
explicit ownership decision. There is no global Docker or simulator prune.
