# Workspace sessions and cleanup

A workspace directory is the ownership boundary for a session. A Git worktree
and an ordinary user directory both work; no task, PR, or Git repository is
required. Any number of agents, tasks, questions, images, commands and sandbox
environments can belong to a workspace. Multiple conversations using the same
directory share its activity and ownership checks.

The canonical path locates a workspace. A stable UUID and directory fingerprint
prevent a replacement at an old path from inheriting deletion authority. A move
of the same directory keeps the UUID. Existing user directories are never
disposable; only a verified managed Git worktree can be removed wholesale.

## Lifecycle

- New work, agent execution, task edits, question answers and command activity
  update the session's last activity. Reading a page and maintenance polling do
  not. New work or restoring an item clears its workspace archive marker.
- After **14 days without activity**, the existing maintenance pass archives the
  workspace if execution, queued input, processes and local filesystem use can
  be checked safely. Archiving changes presentation only; it never stops or
  starts agents, changes task stages, answers questions, or deletes files.
- Linked items appear in the existing collapsible **Archived** sections on
  Agents, Tasks, Questions and Images. Restoring a linked item restores the
  workspace without resuming execution. Individual manual view archives remain
  available; hiding one item does not authorize deleting its active workspace.
- Permanent deletion is explicit:

  ```sh
  orca clean             # Preview discovery, archiving and cleanup; no persistent changes
  orca clean --dry-run   # Same preview
  orca clean --apply     # Recheck and remove eligible archived sessions
  ```

Preview discovery uses an in-memory metadata overlay. Both modes report each
workspace, its disposition and estimated allocated bytes for eligible files.
Shared blocks/hardlinks, concurrent writes and filesystem compression mean this
is not a promise of free disk space. A retained item includes its reason.

## What cleanup owns

The registry uses small namespaces in the existing `memory.sqlite`; it adds no
daemon, model calls or execution workflow. Agents, tasks, questions, image files,
supervised commands, tool output and sandbox evidence register their workspace.
Image handoffs add the recipient workspace, preserving shared ownership.

Cleanup removes archived agent transcripts, run/context records and searchable
copies; unreferenced task ledger records; question records; unreferenced images;
owned output/evidence and settled command directories. Active task dependencies,
saved input and retained conversation references protect their referenced data.
Cleaning an orchestrator also clears its working brief. Saved preferences,
project settings, credentials and reusable prompts/tools/skills remain.
Task number high-water marks and small session deletion receipts remain; SQLite
can reuse freed pages without a disruptive global vacuum.

Verified disposable worktrees can be removed even without a task or merged PR.
Local Git branches and their committed work remain. Dirty source, untracked
files and unknown ignored files are preserved. Known ignored build directories
(including nested dependencies, Rust target directories, Bazel output, Python
caches and iOS DerivedData) can be removed independently when the checkout itself
must remain. `.env` and arbitrary ignored evidence are not treated as build files.

Bazel output bases outside a worktree are matched by their exact workspace
metadata and directory identity. Cleanup checks their server PID and local use.
Shared download/install caches and output bases with unproven ownership remain.
It never runs a global Docker/volume prune or deletes another tool's worktrees.

## Sandboxes

The existing sandbox close, expiry and crash-recovery mechanisms still stop
owned processes and remove containers, private simulators and scratch checkouts
promptly. The default environment lifetime stays 60 minutes. Workspace-owned
evidence now follows workspace archival and explicit cleanup instead of expiring
after seven days. Legacy evidence without ownership retains its prior bounded
policy until discovery associates it with a workspace.

## Existing installs and interrupted cleanup

Discovery reads registered Git worktrees under Orca's managed directory, agent
run records and task metadata. Known activity timestamps are retained. A
directory with no reliable activity evidence gets a new 14-day grace period;
filesystem mtime and a branch name are not evidence that it is safe to delete.
Old images/custom output without a worker association stay with their owning
conversation rather than being guessed into a worker session.

Workspace claims and the existing spawn/turn locks prevent new work from racing
deletion. Liveness is checked again after size inspection. Unknown ownership,
`lsof` being unavailable, permission errors, active processes, undelivered completions and unresolved
sandbox cleanup preserve resources. A dead command's unknown outcome is not
rewritten or replayed; existing PID/process-group checks determine liveness.
If cleanup is interrupted, its claim blocks new admissions until a subsequent
`orca clean --apply` resumes cleanup. Failures retain their metadata and can be
retried; cleanup never starts an agent to finish them.
