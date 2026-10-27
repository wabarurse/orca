# PR2 dependency-provisioned validation

Follow-up to implementation head `cb7ee9be26e29b225e187a10e8ae26583744b032`.
Production code is unchanged. Dependencies were installed in this worktree only
using the documented `bun install --frozen-lockfile`; no manifest/lockfile changes,
new providers, credentials, live Orca installation, or rollout were involved.
This supersedes the missing-dependencies/typecheck caveat in that commit's proposed
PR body. The authorized single code-review round and CI readiness remain next;
there is no merge authorization.

## Changes after provisioning

- Correct the remaining obsolete TASK description assertion to enforce the concise
  immutable-task reuse contract; retain the runtime duplicate-registration checks.
- Give the dependency-example fixture readonly tuples and assert its known first
  prerequisite exists, satisfying indexed-access type checking.
- Raise the orchestrator prompt's size budget from 2500 to 2600 characters to
  accommodate the existing memory/numbered-task pointer (observed 2516). Worker
  and reviewer budgets, mandatory contract assertions and dispatch assertions
  remain unchanged; no production prompt was shortened to satisfy a size test.
- Add `provider-integration.test.ts`: real mounted tools for all roles load through
  the editable-definition loader and OpenAI provider conversion. Verify descriptions
  and input annotations reach provider specs, mandatory contracts remain, handlers
  and allowlists are unchanged, orchestrator TASK edits do not affect the agent TASK
  variant, and adding an input action is refused. SDK imports are exercised; no
  network/provider request or credentials are required.

## Check evidence

All tests were launched with an additional fresh temporary `ORCA_HOME`, removed
on completion, even when the file supplies its own isolated home. Each file ran
in its own Bun process. Final checks below cover the final code in this follow-up
commit; the earlier history result is carried forward unchanged.

| Command | Result | Saved output |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 20 packages installed; lockfile unchanged | `/tmp/orca-pr2-deps-followup.log` |
| `bun run check` | pass | `/tmp/orca-pr2-tsc-followup-3.log` |
| `bun test src/core/tools/history.test.ts` | 22 pass, 157 assertions | `/tmp/orca-pr2-provider-history-1.log` |
| `bun test src/core/tools/task.test.ts` | 10 pass, 92 assertions | `/tmp/orca-pr2-provider-task-final.log` |
| `bun test src/core/prompt/prompts.test.ts` | 23 pass, 462 assertions | `/tmp/orca-pr2-provider-prompts-final.log` |
| `bun test src/core/definitions/provider-integration.test.ts` | 1 pass, 50 assertions | `/tmp/orca-pr2-provider-provider-integration-final.log` |
| `git diff --check` | pass | command output empty |

Initial provisioned typecheck found the dependency fixture's `string | undefined`
(`/tmp/orca-pr2-tsc-followup.log`); next found a mistaken new-test relative import
(`/tmp/orca-pr2-tsc-followup-2.log`). Both fixed before the final passing check.
Initial task tests had one obsolete prose assertion failure
(`/tmp/orca-pr2-provider-task-1.log`); initial prompt tests had two size-budget
failures (`/tmp/orca-pr2-provider-prompts-1.log`). Only changed files were retested.

Previously passing definitions (7), layout (9 plus separate real SQLite retention
case), pull (45), bootstrap/legacy checks and syntax build from implementation
head are carried forward: production code was not changed and those checks were
not repeated. See the implementation worker report for exact commands/logs.
No full suite, baseline comparison, live migration, provider API call or live
process integration was performed. Manual coordinated shutdown/exclusion of old
executables during **and after** migration remains an operator requirement, not
a technical guarantee from the acknowledgement flag.

## Single-review corrections (after `2d484527ae2e209590730f759d78fa8b6840b706`)

This section describes the code in the commit **“Harden offline migration ancestry
and rollback persistence”**; its exact commit ID is provided in the final worker
report (a commit cannot embed its own hash). No further code-review round is
requested. The authorized next step is CI readiness, not merge.

### Findings resolved

1. **P1 source ancestors:** shared layout safety helpers reject unsafe directory
   ownership/permissions and links. Migration validates both legacy and runtime
   project parents before lock scanning/discovery, then validates source,
   destination and backup ancestor chains before inspecting leaves. Legacy
   discovery independently validates project parents, including startup gating.
   Rollback uses the same preflight before any writes. Tests cover linked
   `projects` and `projects/p` containing external runtime children and an
   unresolved lock, and a legacy project parent replaced before rollback; external
   evidence and journal stay untouched on refusal. Existing destination checks
   remain, including same-device refusal.
2. **P2 rollback durability:** apply and rollback share `persistedRename`, syncing
   both parents before terminal journal persistence. Rollback durably enters
   `rolling-back` before moving and only reaches `rolled-back` after syncing.
   Resume re-syncs already-renamed entries and requires explicit rollback mode.
   Injected observer faults after rename and after the first parent fsync verify
   interrupted journal state, startup refusal, direction gating, recovery ordering
   and retained bytes. The observer does not replace filesystem calls. These are
   filesystem fault-ordering simulations, not physical power-loss tests.
3. **Complexity:** cohesive helpers separate ancestry/file validation, journal
   validation, device checks, lock traversal, backup, persisted moves/rollback,
   provenance reading/default reconciliation and schema annotations. No unrelated
   existing TASK/orchestrator/pull complexity refactor. All functions in the five
   changed production files meet cyclomatic <=10 and cognitive <=15.

Repository `scoreSource` measured final scores (cyclomatic/cognitive):
`migrateLayout` 6/6; `locksAt` 6/6 and `scanLocks` 5/7 (replacing nested `locks`);
`assertLayout` 8/9; `definition` 4/4; `annotations` 7/8. Maximum across all new or
changed helpers: 8 cyclomatic, 9 cognitive. Initial extracted `inspect` was 12/11;
extracting root preflight reduced it to 6/5, with `migrationRoots` 7/6. Full scores
are `/tmp/orca-pr2-review-complexity-1.log` (unchanged files) and
`/tmp/orca-pr2-review-complexity-migration-final.log` (final migration).
Command: `bun -e 'import {scoreSource} from "./src/core/tools/complexity/scoring";
for (const file of FILES) console.log(file, scoreSource(await Bun.file(file).text(), file));'`
where FILES were `src/config/{migrate-layout,layout,layout-safety}.ts` and
`src/core/definitions/{files,tools}.ts`; only migration was rescored after changing
its root-preflight extraction.

### Final affected-code checks

| Command | Result | Saved output |
| --- | --- | --- |
| `bun run check` | pass | `/tmp/orca-pr2-review-tsc.log` |
| `bun test src/config/layout.test.ts` | 15 pass, 157 assertions | `/tmp/orca-pr2-review-layout.log` |
| `bun test src/core/definitions/definitions.test.ts` | 7 pass, 43 assertions | `/tmp/orca-pr2-review-definitions.log` |
| `bun test src/core/definitions/provider-integration.test.ts` | 1 pass, 50 assertions | `/tmp/orca-pr2-review-provider-integration.log` |
| `git diff --cached --check` | pass | empty output before commit |

Each test file ran once on final changed code, separately with a fresh temporary
`ORCA_HOME`; all succeeded on the first review-correction test run, so there are
no failed test-output paths for this run. Only complexity had an initial
above-threshold result, retained in the first score log. Final production/test
fingerprints are `/tmp/orca-pr2-review-code-fingerprints.txt`.
Prior history/TASK/prompt tests and unchanged pull/bootstrap results are carried
forward as previously recorded; their files were not modified or rerun. Previous
layout/definition evidence is superseded by the affected-code checks above.
No full suite, baseline, live installation/migration, provider request or physical
power-loss test was run. SQL/auth/WAL retention, immutable identities, editable
contracts and short descriptions remain unchanged. The bin-local installer lock
stays outside the home. Manual coordinated shutdown and prevention of old
launches **during and after** migration remain mandatory. Dynamic dispatch,
configuration and the exactly-two-PR plan are unchanged. The separate queued
dependency-tree workflow is not included.
