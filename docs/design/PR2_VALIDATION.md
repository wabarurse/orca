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
