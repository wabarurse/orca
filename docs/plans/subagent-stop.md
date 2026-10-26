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
