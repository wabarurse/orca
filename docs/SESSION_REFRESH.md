# Shared local session refresh and prompt delivery

## User contract

`/refresh` reads the persisted state used by windows sharing the same
`ORCA_HOME` (normally `~/.orca`). It reconciles names, pins and the
project picker; full saved conversation and next-turn model context; tasks in
an open Inbox panel; open/closed questions; agent liveness; and applicable
model/settings. The picker is read on opening when closed. Accounts/config
continue to be loaded by their normal menus and request boundaries.

Every prompt submission requests the same refresh, even while locally busy or
held during login. Inbox publication starts first and **does not await refresh**.
Held prompts capture project/Page ownership, immutable `inputId` and cancellation
`userEpoch` when submitted, not when login finishes. Refresh requests coalesce,
with a trailing pass when another request arrives during a read. Passive polling
also reconciles receipts from other windows; it retains the question directory's
unchanged-stamp optimization rather than forcing a full question reread each tick.

Safe presentation data can update during a turn. The local orchestrator's
transcript/context reload and history replacement defer while that turn is
running or clearing, and run at idle or before a new turn starts streaming.
Refresh preserves the selected page/panels, prompt and answer ownership, drafts
and cursors, queued input, original pre-compaction history, local diagnostics,
and a source-based scroll anchor where the source still exists. It does not
replay historical tools or reopen answered/skipped questions. If a question was
closed elsewhere, the existing orphan-answer behavior keeps the original chat
draft and reports the typed answer separately.

Refresh is **not** Git pull, harness installation/update, restart, or cross-laptop
synchronization. It does not submit or retry prompts, run the model/tools, advance
cancellation epochs, restart agents, or invoke the exit/merge watchers. Existing
normal inbox polling/work scheduling is separate and continues unchanged. A
refresh error is reported without failing an already submitted prompt.

## Exact consumption, not text matching

The earlier queue symptom had evidence of the user's text already in the
transcript and no unread inbox file, with two running sessions. That suggested
cross-window consumption with stale sender UI; it did not prove every queue bug.
The old local callback ran before transcript commit, discarded input identities
when formatting context, and could not notify another sender window. Inbox
read-then-unlink and cached transcript heads also lacked cross-consumer safety.

The new context-consumption transaction is:

1. Acquire the recipient inbox's cooperative directory lock, refresh the
   transcript snapshot, and read a sorted snapshot of published inbox files.
2. Ignore exact already-committed delivery IDs (`recipient/filename`) and user
   input IDs. Deduplicate repeated input IDs within this batch too. Invalid or
   unreadable records fail closed; no prompt in that batch is silently deleted.
3. Append **one transcript entry containing both model-visible payload and hidden
   `inbox` receipt metadata**. Tool results and newly read instructions still
   commit as one paired user message. User-facing agent replies use the same
   transaction and a `replies` entry.
4. Only after transcript publication commits, remove that inbox snapshot and
   notify local `onInbox`. A failed append leaves original files available.
   Cleanup errors do not turn a committed operation into a failed send.

`Transcript.consumed()` scans all saved entries, including records before a
summary, context boundary or alternate branch. Compaction and `/clear` do not
expire receipts. Crash residue is cleaned without re-delivery, and an
orchestrator cannot run another model turn merely because already-consumed files
remain: it requires fresh consumed input (explicit compaction is separate).

The queue acknowledges only exact **committed `inputId`** evidence, either from
that local post-commit callback or a refreshed snapshot. Text equality, successful
enqueue, turn completion, cancellation, and file disappearance are not receipts.
A provider failure **after** consumption leaves the prompt in model context and
clears its preview; it does not retry automatically. Another explicit prompt can
continue with that retained context. `drain()` remains a serialized destructive
legacy API, not a context-commit API; production context callers use `consume()`.

This is at-most-once context delivery, not exactly-once model execution or tool
side effects. A crash between context commit and the model request does not
replay the request on refresh. A user decides whether to continue. The pending
preview is local to the submitting window; it is not a global inbox inventory.

## Concurrency and cancellation boundaries

- `storage-lock.ts` uses exclusive directory creation plus PID/time (and, for
  turn locks, project) owner metadata. Short transactions have invocation-order
  local queues and bounded cross-process waits. No timer-based lock stealing: a
  lock is taken over only when its recorded owner PID is verifiably gone
  (`ESRCH`), via a claim marker inside the orphan and a rename aside so two
  contenders cannot both win. Live, unsignalable (`EPERM`, which covers PID
  reuse) or unreadable owners are never taken over. Processes in another PID
  namespace (containers sharing one ORCA_HOME) look dead to `kill(pid, 0)`, so
  takeover is only safe when every orca process shares the host's PID namespace.
- Transcript reload, parent selection and staged/fsync/rename publication share
  a per-file lock (`transcripts/<session>.jsonl.lock`). Publication preserves the
  exact old byte prefix. Refresh replaces its snapshot only after successful
  reading/parsing; damaged legacy lines are preserved on disk, not replayed.
- A turn holds two locks outside the project directory for the **whole
  orchestrator model/tool turn**: the checkout-wide `checkout-locks/<sha256>`
  shared by every conversation bound to one original checkout, then the
  conversation's own `turn-locks/<project>` (one path for legacy clones). Their
  owner is the project's **orchestrator daemon** (`src/orchestrator-daemon.ts`,
  the `orchestrator` tmux window), the only process that appends to the
  orchestrator's transcript; TUIs are clients that enqueue input and requests
  and read the transcript back (`src/orchestrator-client.ts`). A losing daemon
  (two conversations on one checkout) returns without starting a competing turn
  and holds nothing; its next poll checks again. The winner reloads shared
  context before starting. Workers retain their existing role/session
  ownership; this is not new worker scheduling or restart behavior.
- One daemon per project: `daemon-locks/<project>` is held for the daemon's
  lifetime (dead-owner takeover as for every lock), and its `owner.json` pid is
  how clients tell the daemon is alive. Requests (`projects/<id>/orchestrator/commands/`)
  are read once; the daemon answers each under its id in `acks/`, and a client
  waiting for an ack gives up when the daemon dies or after 15s. A request the
  daemon read but did not answer (a crash in between) is not retried by anyone:
  the client reports the missing acknowledgement and the user decides.
  `status.json` is advisory presentation state (idle/turn, turn count, last
  error, context estimate); durable truth stays in the transcript, inbox
  receipts, locks and run records. So is `live.jsonl`
  (`src/orchestrator-live.ts`): the running turn's streamed text and tool
  events, each tagged with the transcript head it followed, replaced when a
  turn starts and removed once the turn's entries are durable. Clients only
  read it (keyed by the status's run and turn count, so a dead daemon's or an
  earlier turn's file is ignored) and show an event only while its head is the
  transcript's; a durable entry supersedes the events behind it. Nothing is
  consumed, acknowledged or retried through it, and a client that misses events
  loses nothing but the live view, since the transcript shows the turn when it ends.
- Inbox locks (`inbox/<recipient>.lock`) protect consumption transactions.
  Concurrent puts are atomic and not blocked on a model turn; files published
  after a consumer's snapshot wait for a later boundary. Per-process submission
  FIFO is preserved. Simultaneous independent windows have no invented global
  keystroke order beyond their persisted filename order.
- `/clear` acquires both turn locks too (in the daemon, on the client's request,
  after the client's own disk checks); project deletion only the conversation's
  own, so an idle conversation can be deleted while a sibling on the same checkout
  is mid-turn. Deletion first asks the daemon to stop and waits for its process
  (killing its window after 10s, refusing after 3s more), so nothing writes the
  project's files back after they are removed (deletion never touches the shared checkout's files, and the
  worktrees it unregisters live in the project's own namespace). A refusal names
  the holder (PID, since, project). Clear still uses the project-state lock shared
  with orchestrator publication, and refuses queued input. Captured directory identity prevents stale Pages/queued publications
  from acquiring a deleted/recreated project's state.
- The persisted cancellation epoch also gates other windows' later turns.
  Refresh never changes it. Ctrl+C writes the launch's cancel request
  (`transcripts/orchestrator.jsonl.cancel`, naming the run in
  `transcripts/orchestrator.jsonl.launch`); the daemon takes it (renamed aside,
  so a newer request is never lost), aborts the turn, advances the epoch and
  acknowledges under the request's token. The live daemon owns the launch
  file: it publishes its own run as soon as it holds the daemon lock and
  re-asserts it on every pass, so two TUIs starting daemons in the same poll
  (the loser exits before its run record, but may have published its launch
  last) cannot leave cancels addressed to a run nobody runs. A cancel for a
  dead daemon is never applied by a later launch (it names the exact run), so
  pre-cancel input would run when the daemon restarts; the page says the
  cancel was not acknowledged. Turn locks left by a daemon killed mid-turn
  (dead owner pid) do not gate the next daemon's turns or a clear
  (`turnLocksHeld`/`lockHeld`); taking the turn moves them aside. Pre-cancel input (including late login/persistence)
  and agent reports cannot resume a paused project; fresh human input or an
  explicit compact request is required. Explicit `/compact` retains its existing
  local resume permission until the epoch changes; refresh cannot create that
  permission. Cancellation still aborts the local
  owning request/tools, not arbitrary already-running work in another process.

## Limitations and recovery

**All concurrent consumers/writers must use this protocol.** Older binaries can
still read the additive transcript metadata, but they do not honor new locks or
write exact receipts; an older TUI would also run turns in-process next to a
daemon (both take the turn locks, so they do not overlap, but the older one
cancels and clears only its own process). Let running daemons exit before
upgrading. A mixed-version running population cannot guarantee
exclusive consumption, safe transcript publication or cross-window queue
acknowledgement. Already-consumed legacy messages cannot be assigned receipts
by text or missing-file inference. Never automatically resend them to repair a
badge. This change does not upgrade or restart any existing process.

A crashed process may leave a lock directory. The next contender takes it over
only when the recorded owner PID no longer exists; ownership is deliberately not
stolen based on age: a long model/tool request may still be active. A lock whose
PID was reused, whose `owner.json` is unreadable, or whose takeover was itself
interrupted (a `takeover` marker inside) stays held: a stale turn lock can leave
input waiting; transaction locks time out with a path-specific error. Recovery
is then an **explicit operator action**: first verify all relevant owners are no
longer operating on that project/storage, inspect `owner.json` (PID reuse means
the PID alone is insufficient), and only then remove the specific orphan lock. Do not remove inbox/transcript data or run a second
consumer as a workaround. No recovery action is performed by refresh or tests.

Legacy non-cooperating filesystem editors, network filesystems with weaker
locking/rename semantics, power-loss guarantees beyond the existing publication
protocol, and automatic dead-owner recovery are outside scope. Reload/receipt
scanning is linear in saved history, and copy-on-write append remains linear in
file size; no receipt pruning is introduced because it could permit duplicates.

## Local validation and reviewer handoff

Implementation base: `2aff05c8f2a8af9ad3073a23eb83bd730f9f5b32` (merged CLI/pull
PR #69), branch `feat-session-refresh`. The worker commits locally only. A
separate reviewer starts with `watch ci` and owns publication; **that phrase does
not authorize hosted CI for this task**. Run local review/checks and report exact
head evidence before publication/readiness, using the orchestrator's task flow.

Constraints for this branch: no live inbox/transcript experiments; no changes to
the user's checkout/stash, other worktrees, shell configuration/history,
installed `~/.local/bin/orca` or `~/.orca/app`; no live process
restarts/kills, desktop automation, web/provider/billing fallback, clone-UX
changes, or hosted CI. Do not touch gallery server `127.0.0.1:64830`. Use only
isolated temporary test storage and fake providers/tools; do not validate via
live sign-in/inference. Worker must not push or create a PR.

Relevant local commands:

```sh
bun install --frozen-lockfile
bun test src/session-refresh.test.ts src/tui/refresh.test.ts
bun test
bun run check
bun run build
git diff --check
```

Core regressions cover exact cross-window acknowledgement; same text/different
IDs; overlapping turns and busy input order; failed reads/writes; post-commit
cleanup residue; provider failure; shared cancellation; separate child-process
publication/consumption; legacy drains; malformed input and duplicate-ID batches.
UI regressions cover nonblocking/failed refresh, busy deferral, periodic remote
acknowledgement and busy-to-idle processing, persisted projects/pins/model/settings,
tasks/questions, full pre-stream history, login-held epochs/FIFO, drafts/cursors,
scroll anchoring and pinned bars. Existing suites cover clear/delete, input/editing,
question ownership, cancellations, model settings, and terminal isolation.

Worker's final local validation (Bun 1.4.2): focused regressions **19 passed,
0 failed, 155 assertions**; full suite **996 passed, 0 failed, 8 snapshots,
17,946 assertions across 74 files**. `bun run check`, `bun run build` (549 bundled
modules), and `git diff --check` passed. Five help snapshots were intentionally
updated for the added command; there are still eight snapshots in the suite.
No live provider, installed-app, hosted-CI or mixed-version runtime validation
was performed. Reviewer must rerun checks on its exact reviewed head.

Reviewer follow-up: a losing turn could incorrectly mark a refreshed-but-unrendered
snapshot as already displayed, hiding another window's saved conversation until a
later transcript append. Rendered-head advancement now requires that turn's
pre-stream presentation callback. An isolated real-orchestrator lock-contention
regression failed before the fix and passes afterward, preserving the pending
prompt and draft without any model calls. Reviewer local validation: focused
refresh suites **20 passed, 162 assertions**; full suite **997 passed, 0 failed,
8 snapshots, 17,953 assertions across 74 files**; typecheck, build and whitespace
checks passed. GitHub reports no workflows/checks; no hosted run was requested.
