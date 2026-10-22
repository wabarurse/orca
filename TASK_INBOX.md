# Structured task inbox (data/lifecycle)

The task inbox is a **per-project registry**, not an agent-message inbox, queued
user prompts, Ctrl+Q questions, or a scheduler. Nothing here consumes, answers,
skips or dispatches those queues. There is no historical-chat migration and no
TUI panel/command in this implementation.

## Producers and tools

The orchestrator first obtains the user's task authorization (the existing
planning/authorization policy still applies), then calls:

```json
{"action":"register","name":"Task inbox","summary":"Persist structured task lifecycle","branch":"feat/inbox","authorized":true}
```

The `task` tool returns JSON including a generated immutable UUID `id`. An optional
caller-generated UUID `taskId` makes registration retries idempotent: identical
fields return the same record; conflicting fields are rejected. Display names and
summaries are never identifiers. `spawn` now requires this registered `taskId` in
addition to `prompt`, `branch` and optional `role`.

* Use the **same ID** for a task's retries, review corrections and watch-CI run.
* Register a **new ID** for a separate follow-up task, even on a reusable pre-PR
  branch. Prior records remain. Registration refuses a new task on a branch
  already associated with a PR; the existing branch-reuse policy is unchanged.
* Registration records authorization; it cannot independently prove a human
  authorized the work. It does not spawn anything.
* Agent `task` calls default to the task bound to their exact supervised run.
  Orchestrator calls use `taskId`. An active agent can access/update an earlier
  task on its own branch explicitly by ID, never another branch's task.
* `task list` returns active rows; `task get` returns the retained full record.
* `task attention` takes `kind` (`waiting`, `blocked`, `cancelled`, `closed`,
  `unknown`) and `reason`. This records a stalled state, invalidates readiness,
  and does **not** cancel a process, authorize continuation or complete a task.

After publication, the **reviewer in watch-CI mode** calls:

```json
{"action":"pr","repository":"owner/repo","number":123}
{"action":"ready","validated":true,"validation":"Local tests/check/build and review passed for this exact PR head"}
```

`pr` verifies the project origin, repository/number/URL, non-fork PR and branch
using read-only `gh pr view`. It is also available to the orchestrator. It does
not establish readiness. If one published PR includes earlier tasks on a reused
branch, explicitly associate those IDs too, and have the reviewer validate each
included task. Branch-name matching alone never associates or archives tasks.

`ready` is reviewer-only and requires a currently started reviewer run on the
same branch, a previously started task, explicit `validated:true`, nonempty
validation evidence, a clean local HEAD matching the current PR head, and a
verified open, non-draft, mergeable/CLEAN PR without review blockers or pending,
failed or unknown checks. Missing hosted checks are recorded as `not_configured`,
**not** inferred as readiness: explicit local validation is still required.
Skipped/neutral or unfamiliar check results conservatively do not qualify.
Evidence is the reviewer's structured attestation, not machine execution of a
project-specific test recipe. Report to the orchestrator in full afterwards as
before. Code-review-only rounds never assert readiness. Zero review rounds still
hand off to the reviewer with only “watch ci”; no publishing responsibility moved
to workers. No tool here pushes, opens PRs or merges.

## Automatic lifecycle

| Event | Persisted result |
| --- | --- |
| Authorized registration | `queued`, before dispatch |
| Spawn reservation | Exact task/run/agent binding; worker remains `queued`; reviewer handoff becomes `reviewing`, with launch-pending attention |
| Actual child supervisor starts | `working` for worker, `reviewing` for reviewer; never inferred from runner return |
| Failed launch/write | No fabricated working/ready state; failed launch remains visible with blocked/cancelled attention; failed registry reservation prevents dispatch |
| Normal report/exit | Waiting for the next explicit step, **not ready**; existing blocked/cancelled attention retained |
| Cancellation/crash/missing process | Visible cancelled/blocked/unknown attention; invalidate every included task validated by that run; no auto-continuation |
| New run on branch, shell tool or new agent instruction after validation | Readiness invalidated, including earlier tasks on that branch |
| Explicit validated readiness | `ready_to_merge`, bound to the exact PR head and reviewer run |
| Observed PR-head change, check/review blocker, closed PR or failed refresh | Readiness invalidated; closed-unmerged and unknown tasks remain active |
| Confirmed repository/PR merge | Active row removed; task, runs, events and merge metadata retained |

`cancelSession`, `supervise`/`beginRun`, shell `afterExit` and the TUI's existing
watchdog supply exact-run events. The watchdog gives prepared launches 30 seconds
before treating an unobservable agent as unknown. Missing run files, dead agents
and successful exits are never completion evidence. No historical/unregistered
run is turned into a guessed task. Registry failures are logged without suppressing
existing shell-exit/watchdog notifications.

The existing merge watcher archives matching explicit PR associations **before**
cleanup claims, tmux checks or destructive worktree cleanup. Its exact-PR refresh
also handles registered PRs older than the newest-100 merged list, once per
unique active PR per polling interval (normally 30s). Failed lookups never remove
rows. Forks, unsafe/mismatched links and missing merge timestamps are rejected.
Duplicate observations are idempotent. A newer unassociated task on an old branch
is not archived by that branch's old merge.

## TypeScript / UI contract

Import from `src/tasks.ts`:

* `listTasks(project): Promise<TaskRow[]>` — active rows, registration order.
  `TaskRow` contains only `id`, `name`, `summary`, `branch`, `status`, optional
  structured `pr` / `attention`, `createdAt` and `updatedAt`. Render table columns
  **name | summary | status | PR link**; expose attention so “working” with a
  cancelled/unknown reason is not mistaken for an active process.
* `TaskStatus` / `taskStatuses`: `queued | working | reviewing | ready_to_merge`.
  `taskStatusLabels[status]` gives the human label, including **ready to merge**.
* `TaskPR`: canonical HTTPS GitHub `url`, `repository` (`owner/repo`, lower case),
  positive integer `number`, exact `head` SHA. Never construct links from prose.
* `getTask(project,id)` and `allTasks(project)` include archived history.
* Producers: `registerTask`, `prepareTaskRun`, `startTaskRun`, `stopTaskRun`,
  `setTaskAttention`, `invalidateTaskBranch`, `taskForRun`.
* Trusted GitHub adapters: `observeTaskPR`, `validateTaskReadiness`,
  `archiveMergedTasks`; `src/github.ts` provides `ghTaskPR`/`parseTaskPR`.
  These low-level APIs accept typed observations, not arbitrary tool input;
  use `task` for origin/HEAD/role validation. Readiness uses revision comparison
  to reject races during network/local validation.

The UI should only query typed records, not inspect transcripts/worktrees or
reverse-engineer stage from an agent name. Handle query failures visibly instead
of presenting an empty inbox. No extra polling process is necessary when the
existing merge watcher/watchdog is running.

## Storage and limits

`projects/<project>/tasks.json` is `{ "version": 1, "tasks": Task[] }`. Each record
has immutable UUID, display fields, fixed branch, stage, revision, ISO timestamps,
run associations, optional PR/readiness/attention/archive, and ordered lifecycle
events. Archive metadata includes reason `merged`, confirmed `mergedAt`, local
`archivedAt` and structured PR identity. Validation evidence survives invalidation
in history. Records are retained until the **project itself** is deleted.

Writes use same-directory unique temp + atomic rename (0600), serialized locally
and across processes by the existing project-state lock. Project-directory
identity is checked after locking so queued updates cannot resurrect a deleted
or recreated project. Reads validate schema and fail closed on corruption or
unsupported versions; there is no silent reset. Orphan temp files are ignored.
Normal restart reloads all records; duplicate events don't duplicate transitions.

This intentionally uses the existing lock's conservative policy: a process killed
while holding the project-state lock can leave a stale lock. Writes time out with
its location; remove it **only after verifying no Parallels process is active**.
There is no unsafe timed lock stealing or power-loss/fsync guarantee. Storage is
one small snapshot, read/written and validated in full; history grows with the
project. Polling depends on an open TUI project, GitHub access and `gh`; status is
last observed, not a real-time remote guarantee. Readiness invalidation on shell
activity is intentionally conservative; after ready, send the report without
more shell commands, or validate again. External edits/pushes are detected on
next PR refresh/local validation, not by a filesystem watcher. GitHub Enterprise,
non-GitHub PRs, task editing/rebranching, pruning and scheduling are out of scope.
