# Exact-run stop: audit and merge gates

Audit base: origin/main c2ba2b17be5568d62847587dde4cffed3f0e9dcd,
fetched before work. This milestone does **not** expose stop. It makes spawn
fail closed on unknown liveness. Existing successful spawn inputs and results
are unchanged. No prompt files or general reference documentation are changed.

## Why wiring stop to existing cancellation is unsafe

- `core/tools/spawn.ts` checks worker and reviewer windows before preparing a
  run. Previously, exceptions/null from tmux were treated as no live agents.
  This milestone refuses instead; unknown is not evidence of exclusive access.
- `core/data/tasks/tasks.ts:prepareTaskRun` serializes prepared/started run
  admission on a branch. This is useful but not a process-lifetime lease:
  `stopTaskRun` ends the run without proving process/child termination.
- `core/tmux/cancellation.ts:cancelSession` reads the *current* launch identity,
  writes a run-scoped request, then immediately calls `stopTaskRun`. It cannot
  implement a caller-supplied expected-run stop safely as-is. `watchCancellation`
  polls independently of the inbox, but its controller is cooperative.
- `exec/run.ts` installs that watcher. A blocked event loop cannot poll; an
  abort-ignoring model/tool call need not finish. Run exit records and task
  attention are not a termination acknowledgment.
- `core/tools/bash/bash.ts` starts detached process groups. Abort and process
  exit call `killGroup`, which sends SIGKILL immediately. `core/proc.ts` uses the
  same mechanism. Reusing abort or supervisor SIGTERM therefore introduces
  unapproved force against potentially side-effecting commands.
- `core/tmux/exits.ts` signal handling closes the run and exits; it does not
  establish that all local descendants have terminated. Awaiting `proc.exited`
  establishes shell exit, not every descendant's exit. Escaped/daemonized
  descendants require an explicit containment policy, not a PID guess.
- `Runner.stop` kills branch windows and removes the worktree. It is cleanup,
  **not** a suitable stop operation. Window names slug branches; exact branch,
  task, project and run identity must be verified, not inferred from the slug.

## Staged implementation (each independently reviewed before activation)

1. **This PR: fail closed on unknown branch liveness.** Two code/test files and
   this plan, below 300 changed lines. Gate: focused spawn tests pass. This is
   defensive behavior independent of any dormant stop mechanism.
2. **Dormant lifetime ownership substrate.** Add a run-scoped lifecycle record
   and atomic branch admission/release API with focused concurrency tests.
   Bind project, full branch, task, role, immutable run and supervised process
   identity. Preserve ownership through stop requests and task attention changes;
   stale identities never mutate successors. Missing/ambiguous evidence blocks
   admission. Target 2–5 files, <300 lines; split persistence and admission
   integration if needed. Gate: reviewer accepts crash recovery and identity
   model before integration; no stop schema yet.
3. **Dormant graceful process-control substrate.** Track local children before
   execution, separate stop intent from existing hard-abort semantics, and
   record completion only after process/child verification. Test TERM handling,
   ignored TERM, parent exit with remaining child, and late/stale acknowledgments
   using bounded real-process fixtures. No automatic SIGKILL escalation and no
   force option. Gate: demonstrate containment on supported hosts; escaped
   descendants or unobservable process identity must leave ownership blocked.
   This needs a design decision: portable process groups alone cannot prove
   arbitrary daemonized descendants are gone. Do not claim a complete stop until
   that limitation is addressed or conservatively reported as blocked.
4. **Activation, split into small PRs if needed.** First integrate lifetime
   admission and child tracking across launch/supervision/tool execution, with
   focused integration tests; then expose `action: stop` in existing `spawn`
   only after the ownership/termination invariants hold. Omitted action remains
   spawn. Stop requires caller-supplied exact task/run plus agent identity,
   resolves project from trusted context, and rejects non-orchestrators.
   Schema conditionals must retain existing spawn validation. A bounded external
   control path must work independently of inbox/model/tool progress; an
   unresponsive agent returns still-stopping/blocked without releasing ownership.
   Provide an exact run identifier through compatible spawn/task results; do
   not overload an agent ID as a run ID. Test old spawn calls, stale stop versus
   successor, worker/reviewer exclusivity and repeated stop requests.

Activation result contract: distinguish stopped (verified termination), already
exited (verified historical run), still stopping (bounded wait elapsed), and
blocked (identity/ownership/containment evidence unavailable). Never equate
request publication, a missing window, or an ended task with stopped. Every stop
result warns remote operations may continue. No reset, worktree removal, auto
respawn, or automatic force escalation. Replacement reuses task/branch only on
explicit authorization and after inspecting existing commits/uncommitted work.

Prompt follow-up must be sequenced after the parallel CI-guidance PR: explain
exact-run stop, bounded statuses, remote-operation caveat and inspection before
replacement in orchestrator guidance. No shared prompt edits in this milestone.

## Scope and unresolved evidence

Only the fail-closed admission correction is implemented here. Full external
stop, child containment and persistent ownership are **not implemented**. Do not
publish this as a completed stop feature. Audit findings are source inspection,
not empirical termination guarantees. No full suite or baseline is required for
this milestone; run only `bun test src/core/tools/spawn.test.ts`.

Milestone check: `bun test src/core/tools/spawn.test.ts` was attempted once on
this milestone's final code state. It failed during module loading: missing
`@anthropic-ai/sdk`; 0 tests passed, 1 loader error. Output saved at
`/tmp/feat-subagent-stop-spawn.log`. No unchanged retry, full suite, or baseline
was run. Passing test evidence remains a review/merge gate.

Authorized dependency repair: `bun install --frozen-lockfile` succeeded without
tracked dependency changes (log `/tmp/feat-subagent-stop-install.log`). On the
unchanged code tree of commit `8cd0929d11e25dcb73833be64165663f961e618e`, the
subsequent authorized `bun test src/core/tools/spawn.test.ts` passed: 14 tests,
61 expectations, zero failures (log
`/tmp/feat-subagent-stop-spawn-installed.log`). `bun run check` also passed
(log `/tmp/feat-subagent-stop-check.log`). No duplicate passing checks or full
suite were run. Only this evidence paragraph and commit metadata changed after
validation; code/test results carry forward unchanged.

Future work remains separate tasks/branches after this prerequisite merges:
dormant ownership/control mechanism, then activation. Conservative policy is
sufficient: no auto-force, and uncertain or escaped descendants block
replacement. Universal containment is not required; raise only concrete narrow
containment decisions encountered when implementing that policy.

## Milestone 2: dormant exact-run ownership (after #133)

Prerequisite #133 is merged at cb6484ae22dbbf4f360582a42324bf63ad959657.
`core/data/run-ownership/ownership.ts` adds a trusted-supervisor-only API; no
production callers, tool schema, spawn wiring or cancellation changes yet.
The independent ledger is outside project directories, under `run-ownership`,
serialized by the existing cross-process project state lock and atomically
replaced. Task terminal/attention state cannot release it. Existing
`cancelSession` still ends task bookkeeping prematurely; it is not a lifetime
acknowledgment and must not be used as one during integration.

Contract for the next stage:
- Reserve before allowing execution, passing project filesystem incarnation,
  full branch, task, agent, role, immutable run and supervisor host/boot/PID/OS
  birth token. A PID or agent name alone is insufficient. Caller inputs are
  snapshotted before waiting. Released run IDs remain tombstoned, never reused.
- First acquisition (including a missing ledger) requires a trusted verified
  containment inventory, not missing tmux/task-terminal evidence. Unknown blocks.
  Exact active retries are idempotent; worker/reviewer reservations exclude one
  another. No existing spawn path uses this admission API yet.
- Stop intent retains ownership. Release requires an exact-owner attestation of
  supervisor exit, all descendants gone and sealed containment (no new children
  can start). This API validates the attestation's identity and shape, not OS
  truth: only a later trusted verifier may produce positive evidence.
- No time-based recovery or supervisor-PID reclamation. Crash leftovers, corrupt
  ledgers and project recreation fail closed. Old ledgers survive recreation;
  even a new incarnation requires separately reviewed explicit recovery. Stale
  project locks also block. Atomic rename handles process interruption, not a
  claim of fsync-level power-loss durability; missing data still needs inventory.

Stack/merge gates: prerequisite #133 merged → **current ownership** (review
identity/crash model and focused concurrency evidence) → graceful control
(real-process TERM/ignored TERM/remaining-child tests and supported-host identity
and containment verifier) → lifecycle integration (reserve before execution,
track children before launch, seal before release, separate cancellation from
hard abort, handle failed launches without guessing) → activation (exact-run
schema/auth/result contract). Each remains independently reviewed. No stop
activation, live admission, auto-force, worktree reset/removal or auto-respawn.

Milestone checks: frozen dependency installation passed (no tracked dependency
changes); `bun test src/core/data/run-ownership/ownership.test.ts` passed 8 tests,
40 expectations, including independent-process admission; `bun run check` passed.
Logs: `/tmp/feat-subagent-run-ownership-{install,tests,check}.log`. Checks ran once
on final code/test state; only this documentation was appended afterward.

## Revised milestone 3: dormant exact-run tmux interrupt

User chose practical Ctrl+C instead of proving all descendants gone. This slice
adds `core/tmux/interrupt.ts` and its tests, with **no production callers**. It
is not a delivered stop action. Stack: #133 → #134 → current interrupt primitive
→ lifecycle/enrollment and persistent uncertain-stop admission guard → activation.
Existing launches are unaffected. No provider or shared lifecycle code changed.

A trusted future launcher supplies full project/task/branch/agent/run identity,
a fresh launch UUID, exact pane ID/PID, and the launch's server/socket. It must
install the encoded identity as a pane option before opening an execution gate,
retain dead panes, and never respawn/reuse an enrolled pane. The primitive checks
that binding and PID in tmux's `if-shell -F`, then queues `send-keys C-c`. This
avoids a shell predicate subprocess, **not** an OS identity guarantee or an atomic
lock against other tmux clients. Enrollment/stop serialization and prohibition of
pane respawn are activation gates, not invariants enforced by this helper.
The real fixture confirms options survive respawn; PID mismatch rejects that
case, but eventual PID reuse is not solved by the PID comparison.

Results distinguish `agent-exited-cleanup-unverified` (the retained enrolled
pane command exited), `still-running` (observed within the bounded interval),
and `unknown` (missing/mismatched pane, transport failure or no observation).
Exit means agent exit only under the future launch-wrapper contract; this helper
does not inspect OS descendants. Dispatch has a one-second client deadline and
observation accepts at most ten seconds. Client timeout sends TERM only to its
own tmux client, with no escalation; it may not undo an already queued interrupt.
Ctrl+C targets the terminal foreground group. Existing SIGINT/process-exit hooks
may SIGKILL known tool groups: **this is not guaranteed graceful cancellation**.
There is no added agent force, task cancellation, ownership release, cleanup,
respawn or worktree removal. Every result warns cleanup is unverified and remote
operations may continue.

Live activation is unsafe today: exit handlers close task bookkeeping, and
spawn/runner do not consult dormant ownership. Next work must persist an exact-run
uncertain-stop guard in the existing registry/ownership storage BEFORE dispatch,
and enforce it across branch admission/launch independently of exit handlers.
Do not forge the old all-descendants-gone release attestation. This guard plus
launch enrollment must be reviewed/tested before adding a public action. No new
general cancellation framework, containment infrastructure or provider changes
are needed for the narrowed goal.

Checks on this slice's final code: frozen install succeeded; focused
`bun test src/core/tmux/interrupt.test.ts` passed 2 tests, 24 expectations,
including a private disposable tmux server (INT exit, ignored INT, stale run/PID,
missing pane and respawn). No active agent was targeted. `bun run check` failed
with four diagnostics in existing provider bounded-request/transport files;
none in this slice. Provider fixes are separate work, not modified here. Logs:
`/tmp/feat-subagent-graceful-stop-{install,tests,check}.log`. No full suite,
baseline or duplicate checks. Only this documentation changed after checks.
