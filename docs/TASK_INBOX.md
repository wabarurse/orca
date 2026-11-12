# Tasks, Agents, Questions and Images

Ctrl+A, Ctrl+T, Ctrl+Q and Ctrl+B open the one work page on Agents, Tasks, Questions and Projects; Images is its fourth tab (`4`, Tab or `h`/`l`). The slash commands that used to open these views are gone.
Each shows a list and a details pane, stacked on narrow terminals.
Use arrow keys to select and focus, Enter to open, `r` to refresh and Esc
to return to chat. The footer shows this project's agent, task, question and image
counts. A question mark indicates an unavailable count.

Every page has a collapsed **Archived (N)** section when archived items exist.
`a` toggles it; select its header and use Enter or right/left to expand/collapse.
Active items remain visible above it. `d` archives the selected eligible item,
`D` bulk archives eligible items, and `u` restores an archived item to the main
list. Archiving asks for confirmation and retains all records/files. Restoring
does not resume work or reopen/answer questions.

Tasks support jumping by number (including archived tasks), archiving merged or
abandoned/closed tasks with no active runs or open PR, and abandoning eligible
work with `A`. IDs, dependencies and history survive archive/restore. A new
authorized dispatch restores an archived task to the list. Agents support `s`
to stop the selected run; only verified exited agents without queued messages
or active/unresolved commands can be manually archived. Older finished agents
from the existing 24-hour filter appear in Archived, and restored agents stay
in the main list until explicitly archived again.

Answered, skipped and withdrawn questions automatically appear in Archived.
Archiving an open question dismisses it without an answer or agent wakeup;
restoring a closed question shows its saved answer/reason without reopening it.
Images can be archived/restored while retaining their bytes and chat references.
Archived images can still be opened and do not count in the footer image count.
Workspace inactivity also groups linked items under Archived after 14 days.
`orca clean --preview` previews eligible workspace cleanup; `orca clean` permanently removes
its owned records and unreferenced files. Manually archiving one item does not
make an active workspace eligible. See [workspace cleanup](WORKSPACE_CLEANUP.md).

`/vim` toggles Vim controls. The mode label sits on the input box's top border
(beside the bottom controls on full-page lists). In Normal mode, hold Shift and
press a shortcut; no Space prefix or terminal-specific integration is needed:

- Shift+H/L: previous/next project (`gT`/`gt` also work).
- Shift+A/T/Q/P: Agents, Tasks, Questions, Images & Videos.
- Shift+U/M/E/F: Accounts, Model, Effort, Fast mode.
- Shift+B/R/S: Projects, Refresh, Stop.
- Shift+V/X: attach clipboard image, remove last draft image.
- `?` (Shift+/): Help. `:`: run any slash command.

These shortcuts work across chat, work pages, settings, Help and Projects.
Confirmations and command entry retain their own input. `i` enters Insert;
Esc returns to Normal and preserves the draft. Uppercase letters are ordinary
text in Insert mode. `q` goes back, `j/k` and `gg/G` navigate, and `h/l`
switch panes. In Tasks, `c` requests abandonment with confirmation (Shift+A
always opens Agents). Ctrl+A/T/Q still open Agents/Tasks/Questions.

Images & Videos lists images delivered in this conversation and retained
recordings from its registered sandboxes, newest first. Selection only shows
details. Enter opens the selected image in Preview on macOS, or a video in the
system video player; Linux uses the default desktop viewer. No inline terminal
previews, automatic popups, image conversion or preview cache. Over SSH, Orca
reports the remote file location instead. Recordings are discovered on page
open or `r` refresh; supported formats are MP4, MOV, M4V and WebM. Existing
sandbox evidence cleanup still applies. The footer counts delivered images,
and includes recordings once the page has discovered them. Dates use
three-letter month names and the machine's local timezone.

## Answering questions

* Chat drafts and unfinished answer drafts (including their cursors) belong to
  their captured page. Switching sections, closing/reopening or switching
  projects preserves both. Project changes close Questions; explicitly reopen
  Questions to resume its answer. Navigation never submits, consumes pending
  prompts, calls a provider, mutates task records or answers/skips questions.
  Background turns and existing polling continue independently.
* Questions reuse the existing controller/store. The selected question
  opens its answer form in the detail pane, with numbered options,
  **type your own answer**, and **skip — remove from inbox**. No question controls
  appear under the chat composer. A successful answer returns to the list.
  In Vim Normal mode, `i` starts editing; `q` returns to the list without sending.
  ↑↓ moves among rows (and within multiline answers); 1–9 picks an option on an
  option row; typing enters `answer>`. Enter explicitly sends the selected option
  or typed answer. Selecting skip and pressing Enter, Ctrl+D in the answer panel,
  or confirmed `d`/`D` archival in the Questions page dismisses a question:
  it durably leaves the unanswered queue and decrements
  counts, retaining its skipped record/history. Ctrl+D deletes the shown
  question from either the pick or `answer>` mode (for one that is outdated or
  already answered in chat); no editing key uses it, so it never clashes with
  typing an answer. It waits out the same half-second guard, is single-flight and
  restores the chat draft like Skip; an unfinished typed answer is not sent but
  reported separately once deleted. Its note is `→ deleted, removed from inbox`. It sends no user/orchestrator message, queues no answer
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
  Successful final answers, skips or deletes close the panel; explicitly opening an empty queue shows **No open questions**.
* The orchestrator sends a question with `inbox` using `action: "send"`,
  `to: "user"`, `reply: "required"`, and either `text` or a batch of `questions`.
  Sending a note through the same tool uses `to` and `text` without requiring a reply.
  The orchestrator manages pending questions with `action:
  "list"` returns this project's open questions (id, time, text, options,
  default); `action: "close"` with `ids` (at most 20) and a short `reason`
  withdraws open ones that were answered in chat or became outdated. A
  withdrawal is stored as `skipped` with that `reason`: no answer is recorded and
  no reply message is delivered. It is scoped to the calling project and to open
  questions; other ids are reported as not closed. The user's answer always
  wins: a close that finds the question answered is refused and quotes the
  answer, a close that loses the claim waits briefly for the winner, and an
  answer arriving after a withdrawal is still recorded and delivered once
  (a separate exclusive `.answered` claim). The TUI treats a withdrawal like any
  close elsewhere, and its next poll updates the question count.
* An externally closed row disappears. If it had an unfinished answer, that
  orphan text is reported separately, never silently assigned to the next question
  or substituted for the original chat draft. Menus/help retain precedence. Ctrl+B
  projects, model/settings menus, `/help`, cancellation and Cancel-default `/clear-context`
  still work. Ctrl+Q opens the Questions page from menus and project lists.
* In an agent transcript, opening Questions shows the project’s questions.
  q/Esc returns to the agent transcript. Selecting a question opens its answer
  form on the Questions page and leaves the transcript view.
* Captured page/panel ownership suppresses late reads and answer UI results after
  closing/deleting/recreating pages. A successful in-flight answer belongs only
  to its original still-open page, even if another page is selected; late errors
  and orphan-answer notes also stay in the project history, never an agent view. Reads never
  reopen a closed panel or switch its section. A started durable answer is not
  undone by navigation.

### Tasks section (read-only)

The table remains **Name | Summary | Status | PR link**. The current state is
exactly one of **queued**, **working**, **waiting**, **pr open**, **merged**, or **closed**.
Tree rows, task tool responses and compaction task snapshots share the same
projection. Confirmed merges win; a PR closed without merging is **closed**.
Resuming implementation marks **working** while retaining the PR link and
publication history. An unpublished iteration blocked or paused before pushing
is **waiting**. After publication is recorded with `task pr`, the task is
**pr open**, including while awaiting review, CI or the user. Routine PR polling
cannot clear an iteration, even if it observes a different head. Cancelled or
explicitly closed tasks without an open PR are **closed**; other holds are
**waiting**. Reasons remain in details.
Review work is **working**. Legacy readiness without an OPEN observation is
**waiting**; a link or historical checkpoint alone cannot prove a PR is open.
An open PR is publication evidence, not a readiness or activity claim, and waiting
never authorizes a restart. Colors: queued grey, working cyan, waiting yellow,
pr open green, merged purple, closed red.
The stored lifecycle, attention, checkpoints, IDs, task numbers and SQL schema are
unchanged; historical ledger milestones keep their compatible checkpoint format.

A stage is not a claim that a process is running. Exit/report prose never
establishes readiness/completion.

* **↑/↓**, **Page Up/Down**, **wheel**, **Home/End** scroll Tasks, not the
  conversation/composer. **r** rereads the local registry, not GitHub immediately.
  Enter, typing and paste do nothing. Close before editing chat.
* Reads refresh through the existing TUI poll (normally 2s), including after
  watchdog/merge-watcher work. The existing GitHub watcher normally queries every
  30s. A **confirmed exact associated PR merge** marks matching rows merged on
  refresh; explicit archival moves them to the collapsed section. No separate polling process, transcript
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

The coordinator can register an authorized assignment with `task create` or `task register`, giving it a title/name, summary and branch. Tasks retain immutable UUIDs and stable project numbers; duplicate retries are idempotent. `task update` edits title/summary. `task dependencies` records explicit prerequisites without scheduling agents or gating publication.

Every `spawn` is tracked: with a taskId it runs for that task, and without one it reuses the branch's open task or registers one (`taskForBranch`), named by `title` or the brief's first line. So work an agent publishes always has a task for `task pr` to link and the PR watcher to follow. Agents can update their own active task, while the coordinator manages the list. Publish through ordinary Git/GitHub tools only when authorized. Immediately after creating a PR or pushing updates to an existing PR for an assigned task, call `task` with `action: "pr"`, `repository` and `number`; active workers/reviewers default to their run's task. Do this before waiting for review/CI or reporting completion. A verified OPEN PR, including a draft, sets the displayed status to **pr open** immediately in the ledger; the TUI picks it up on its next normal refresh. No reviewer handoff or 30-second GitHub watcher tick is required. A branch push without a PR does not change the task to **pr open**. Failed linking must be reported with the PR URL, without claiming the task updated.

Before implementation resumes in the same run, use `task work`. This records an
unpublished iteration, clears old readiness and marks **working** without
starting any process. A newly started worker on an open-PR task does this
automatically; launch preparation and reviewer-only runs do not. `task pr`
acknowledges publication and ends the iteration. Use `task get/list` to inspect
status, not `task pr`. Closing or merging the PR also ends the iteration.
The optional iteration timestamp lives in the existing task safety record;
checkpoint storage and SQL schema stay compatible, with no data migration.

`task ready` is an optional annotation of validation evidence on an exact clean PR head. It requires observed eligibility and current evidence; it grants no merge permission and never gates publication. `task attention` records a blocker, cancellation or unresolved decision without authorizing execution. Confirmed membership removal retains SQL history.

There are no checkpoint, prepare_publication, checks, reviewed or publish task actions. Branch updates, review and CI observation follow the assignment and repository instructions. Merge notifications update task status without stopping agents or deleting workspaces.

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
| Explicit validated readiness | `ready_to_merge`, bound to the exact PR head and active owning run |
| Observed PR-head change, check/review blocker, closed PR or failed refresh | Readiness invalidated; closed-unmerged and unknown tasks remain active |
| Confirmed repository/PR merge | Row marked merged; task, runs, events and merge metadata retained |

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
readiness (`readiness_invalidated`); "unknown" mergeability (not computed yet,
or the lookup failed) is reported as unknown, never as a conflict. Later polls
do not recheck a PR reported unknown (the per-poll refresh does not act on
mergeability), so unknown is not clean.

## TypeScript / UI contract

The operations live in `src/core/data/tasks/tasks.ts` (imported through the
`src/core/data/tasks` barrel); the record types (`TaskRow`,
`TaskStatus`/`taskStatuses`/`taskStatusLabels`, `TaskPR`, `Task`,
`PRObservation`) and `taskPR` are `src/protocol/tasks.ts` (the `src/protocol`
barrel). The layout and the barrel rule are enforced by `src/organization.test.ts`:

* `listTasks(project): Promise<TaskRow[]>` — active rows, registration order.
  `TaskRow` contains only `id`, `name`, `summary`, `branch`, `status`, optional
  structured `pr` / `attention`, `createdAt` and `updatedAt`. Render table columns
  **name | summary | status | PR link** using `publicTaskStatus`; keep attention
  kind and reason in details. This does not change the registry or turn attention
  into a lifecycle event.
* `TaskStatus` / `taskStatuses`: `queued | working | reviewing | ready_to_merge`.
  These are private lifecycle values. Public labels come from `publicTaskStatus`,
  which also accounts for publication and attention.
* `TaskPR`: canonical HTTPS GitHub `url`, `repository` (`owner/repo`, lower case),
  positive integer `number`, exact `head` SHA. Never construct links from prose.
* `getTask(project,id)` and `allTasks(project)` include archived history.
* Producers: `registerTask`, `prepareTaskRun`, `startTaskRun`, `stopTaskRun`,
  `setTaskAttention`, `invalidateTaskBranch`, `taskForRun`.
* Trusted GitHub adapters: `observeTaskPR`, `validateTaskReadiness`,
  `archiveMergedTasks`; `src/core/data/tasks/github.ts` provides `ghTaskPR`/`parseTaskPR`.
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


## Jump to a task number

In the Ctrl+T task tree, type a task number and press Enter. Digits accumulate
without a timer, so `13` selects #13 rather than briefly selecting #1. Backspace
edits the number; Escape cancels the number entry, and a subsequent Escape returns
to chat. A missing number leaves selection unchanged and shows a notice.
An archived number expands Archived and selects its retained task.
The jump uses stable task numbers rather than row positions, unfolds only the
selected task's primary ancestors, scrolls it into view and focuses the list with
details reset to the top. Other folded groups and the chat draft stay intact.
Jumping is local navigation: it does not submit a prompt, start agents, or write
task state.


The Ctrl+T tree separates the list from details with a horizontal rule. At 80
columns or wider, details wrap in two columns: description, prerequisites and unblocked tasks on
the left, and state, run/attention/validation information, retained
checkpoints and PR links on the right. Smaller terminals stack the original
fields. The detail viewport still scrolls vertically; columns do not truncate
evidence or change task state.
