# USER inbox: Tasks + Questions

The **per-project USER inbox** combines two distinct backing stores: the durable
structured **task registry** (`tasks.json`) and the existing **questions** store
(`questions/`). This is a display move, not a migration, scheduler or agent-message
inbox: no task reconstruction, record recreation, automatic answer/skip or queue
consumption. **`/agents` remains a separate agent list/transcript view.**

## TUI (`/inbox`, Ctrl+Q, `/questions`)

`/inbox` opens **Tasks**, below the multiline composer and counts, like `/help`.
Small **Tasks / Questions** tabs show one compact scrolling section at a time;
there are no cards or dashboard containers.
**Shift+Tab** switches **Tasks / Questions** without selecting an answer; **Esc**
or plain **Tab** closes. Ctrl+Q opens **Questions** from chat, Tasks or help, and
closes it when already shown. `/questions` remains a compatible direct shortcut.
Commands accept no arguments and create no project/session with no page open.
Question arrivals only update the badge; they never open a panel.

The footer says **Inbox N**: N counts **unanswered questions in the selected
project**, not tasks, running agents or queued prompts. **Inbox 0** means a
successful read found no unanswered questions, **Inbox ?** means not yet read or
a read failed. Background open pages contribute **(+N elsewhere)**; unknown
background data is **(+? elsewhere)** (or **(+N+? elsewhere)** with known pending
questions too). Narrow status rows shorten this to **Inbox N +M**. Counts remain
separate from running-agent counts and queued-prompt counts/previews; tiny screens
may clip/hide them to preserve the composer. Failed question reads retain their
last snapshot with a visible stale/error warning, never a fabricated zero.

* Chat drafts and unfinished answer drafts (including their cursors) belong to
  their captured page. Switching sections, closing/reopening or switching
  projects preserves both. Project changes close the inbox; explicitly reopen
  Questions to resume its answer. Navigation never submits, consumes pending
  prompts, calls a provider, mutates task records or answers/skips questions.
  Background turns and existing polling continue independently.
* Questions reuse the existing controller/store. The oldest pending question
  shows numbered options, **type your own answer**, and **skip — remove from inbox**.
  ↑↓ moves among rows (and within multiline answers); 1–9 picks an option on an
  option row; typing enters `answer>`. Enter explicitly sends the selected option
  or typed answer. **Only selecting skip and pressing Enter dismisses a question**:
  it durably leaves the unanswered queue and decrements counts, retaining its
  skipped record/history. It sends no user/orchestrator message, queues no answer
  delivery, applies no default and never calls a provider or wakes/resumes an
  agent (including paused/cancelled work). Silence and panel dismissal are not
  Skip, and neither applies a default or grants approval. The optional stored
  default is only a suggestion the user may explicitly answer with.
  A half-second guard applies on opening/reopening and each new question. During
  answer delivery or skip persistence input is frozen, but dismissal/section/page
  navigation still works; failures retain the question and drafts for retry. Explicit answers
  retain the existing durable reply format and delivery path. Skip has only a
  local removed-from-inbox history note, never durable model input; historical
  delivered skip/default messages still restore unchanged. Exclusive `.closed`
  claims prevent double closes; failed persistence/delivery rolls back before
  releasing the claim. If rollback itself cannot persist, the claim stays held
  rather than risk duplicate delivery; no automatic claim stealing is added.
  Successful final answers or skips close the panel; explicitly opening an empty queue shows **No open questions**.
* An externally closed row disappears. If it had an unfinished answer, that
  orphan text is reported separately, never silently assigned to the next question
  or substituted for the original chat draft. Menus/help retain precedence. Ctrl+B
  projects, model/settings menus, `/help`, cancellation and Cancel-default `/clear`
  still work. Ctrl+Q does nothing while a menu/project list owns keys.
* In an agent transcript, opening Questions shows an explanatory guard and takes
  no answers: close Inbox, then Esc or `/back` to return to the project
  orchestrator. Closing Inbox itself never leaves the agent view. Agent lists
  are not part of Inbox. Late agent-menu results cannot attach a different page.
* Captured page/panel ownership suppresses late reads and answer UI results after
  closing/deleting/recreating pages. A successful in-flight answer belongs only
  to its original still-open page, even if another page is selected; late errors
  and orphan-answer notes also stay in the project history, never an agent view. Reads never
  reopen a closed panel or switch its section. A started durable answer is not
  undone by navigation.

### Tasks section (read-only)

The table remains **Name | Summary | Status | PR link**. Status is **exactly one
plain human label**: stored attention kind (**waiting**, **blocked**, **cancelled**,
**closed**, **unknown**) if present, otherwise lifecycle (**queued**, **working**,
**reviewing**, **ready to merge**). No `!` prefix, second lifecycle line, reason,
metadata or per-task detail appears underneath. This is display precedence only;
stored lifecycle, attention and reason remain untouched, and readiness is never
inferred.
A stage is not a claim that a process is running. Exit/report prose never
establishes readiness/completion.

* **↑/↓**, **Page Up/Down**, **wheel**, **Home/End** scroll Tasks, not the
  conversation/composer. **r** rereads the local registry, not GitHub immediately.
  Enter, typing and paste do nothing. Close before editing chat.
* Reads refresh through the existing TUI poll (normally 2s), including after
  watchdog/merge-watcher work. The existing GitHub watcher normally queries every
  30s. Only a **confirmed exact associated PR merge** removes matching rows on
  refresh; archived records stay on disk. No separate polling process, transcript
  scan, branch/name guess or archive pruning is added.
* Loading and query failures are explicit. Failed refreshes label retained
  snapshots potentially stale even while scrolled. Empty means **no active
  registered tasks**, not that historical/unregistered work completed. Offline or
  failed GitHub observation proves nothing about merge/readiness; stored status
  is last observed, not a real-time remote guarantee.
* At 72+ columns the table has a pinned heading; narrower screens use labelled
  records. Long fields/URLs wrap. The composer/header win on tiny screens; a
  hidden panel still owns keys until Esc. The selected question decision and key
  hint take priority over question text on short screens. Panel scrolling is
  transient; resize reflows without replacing the underlying conversation/draft.
  Large registries are read/validated/laid out in full, not paginated.
* Only canonical structured GitHub PR URLs are linked. Wrapped fragments use
  validated OSC 8 links with the actual URL visible; no browser command launches.
  Untrusted task/question fields, defaults/options and errors have terminal
  styling/control/bidi sequences stripped. Native link/wheel behavior depends on
  the terminal; **physical Apple Terminal wheel/shell-history isolation remains
  unverified**. Synthetic tests do not prove it fixed.

Neither section is saved as chat or printed in the exit transcript. This is not a
task editor, historical archive browser or replacement for agent message queues.
`/help` lists Inbox navigation and both entry commands under Conversation.

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

* Use the **same ID and branch** for a task's retries, review/CI corrections,
  watch-CI run and user-requested fixes to its unmerged PR, even after a ready
  report. Find the record with `task list/get` and refresh its PR state with
  `task pr` before resuming. Message its running agent or spawn its worker again;
  then run the task flow and update the same PR. Do not register a new task or
  create a temporary branch to transfer the fix back. New activity invalidates
  readiness; the reviewer must validate the updated PR head again.
* Register a **new ID** for a separate follow-up task, even on a reusable pre-PR
  branch. Prior records remain. Registration refuses a new task on a branch
  already associated with a PR and points corrections back to the existing task.
  Separate work after PR publication and work after a merge need a new branch.
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
{"action":"ready","validated":true,"validation":"Worker's relevant-check evidence matches this PR head; diff and complexity reviewed; hosted checks passed or absent. No tests rerun by reviewer."}
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
**not** inferred as readiness: the worker's relevant-check evidence must still
cover the current code. The reviewer matches that existing evidence to the PR
head rather than rerunning tests or adding local validation. Missing or stale
evidence and unresolved failures are reported through `task attention`.
Skipped/neutral or unfamiliar check results conservatively do not qualify.
Evidence is the reviewer's structured attestation, not machine execution of a
project-specific test recipe. Report to the orchestrator in full afterwards as
before. Code-review-only rounds never assert readiness. Zero review rounds still
hand off to the reviewer with “watch ci” and worker evidence; no publishing responsibility moved
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
is not archived by that branch's old merge. When it handles a merge, the watcher
also looks up every other active task's PR once and, where GitHub reports it
conflicting (`PRObservation.mergeable` "conflicting": `mergeable` CONFLICTING or
`mergeStateStatus` DIRTY), `blockConflictingTask` sets attention blocked
("conflicts with main after PR #N merged; rebase needed") and invalidates
readiness (`readiness_invalidated`); "unknown" mergeability is reported as
unknown, never as a conflict.

## TypeScript / UI contract

Import from `src/tasks.ts`:

* `listTasks(project): Promise<TaskRow[]>` — active rows, registration order.
  `TaskRow` contains only `id`, `name`, `summary`, `branch`, `status`, optional
  structured `pr` / `attention`, `createdAt` and `updatedAt`. Render table columns
  **name | summary | status | PR link**; show attention kind instead of the
  lifecycle label when present, with no reason or other per-task status detail.
  This does not change the registry or turn attention into a lifecycle event.
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
its location; remove it **only after verifying no orca process is active**.
There is no unsafe timed lock stealing or power-loss/fsync guarantee. Storage is
one small snapshot, read/written and validated in full; history grows with the
project. Polling depends on an open TUI project, GitHub access and `gh`; status is
last observed, not a real-time remote guarantee. Readiness invalidation on shell
activity is intentionally conservative; after ready, send the report without
more shell commands, or validate again. External edits/pushes are detected on
next PR refresh/local validation, not by a filesystem watcher. GitHub Enterprise,
non-GitHub PRs, task editing/rebranching, pruning and scheduling are out of scope.
