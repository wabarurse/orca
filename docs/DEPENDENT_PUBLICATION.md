# Early dependent development, gated PR publication

For users with explicit task dependencies, Orca can prepare dependent code before
prerequisite PRs merge. The existing task tool and spawn tool own this workflow;
there is no new scheduler, inferred task-number ordering, automatic merge, or
change to deployment/configuration settings. PR157's runtime-layout prerequisite
is merged. Its manual migration scripts remain unrelated and are not run here.

1. Register authorized tasks and explicit `task dependencies` UUID edges.
2. The prerequisite worker commits clean code and calls `task checkpoint`.
   After that worker stops, its immutable checkpoint can seed a dependent
   `spawn` with explicit `baseCommit`. The selected commit must contain every
   open prerequisite checkpoint and latest origin default. Divergent parents
   fail closed: Orca does not silently choose or merge a composition.
3. Dependent development stays local. Once **all transitive prerequisites** have
   verified GitHub merge observations, its worker calls `task prepare_publication`.
   This refreshes origin's actual default branch, replays only dependent commits
   in a scratch checkout, saves protected original/candidate refs and a durable
   receipt, then adopts the candidate with `git reset --keep` (never `--hard`).
   Clean-head checks and `--keep` prevent discarding user work. Conflicts and
   merge commits require explicit worker/user resolution, not automatic repair.
4. The worker runs only affected checks once for the resulting code state and
   calls `task checks` with those commands and validation/output evidence. The
   tool captures the actual clean head/default and supervised worker identity;
   it does not rerun tests or certify a model's claimed result independently.
5. Independent tasks retain the configured zero-review path. Dependent tasks
   require an explicit review-mode handoff even when `maxReviewRounds=0`; a
   missing review fails closed without changing configuration or launching an
   agent automatically. A separate review-mode reviewer records `task reviewed` with its findings,
   reusing worker evidence. A watch-ci reviewer calls `task publish`. It verifies
   the recorded DAG merges, actual clean head, latest default, worker evidence
   and review before **either** push or `gh pr create`. PR title/body come from
   the first commit. A failed/timeout create is reconciled by a bounded lookup,
   not a blind duplicate create; verified publication is immediately recorded.
6. Watch CI separately. `task pr` may record historical evidence but cannot
   make dependent work ready without the same latest-default, protected B-only
   replay-candidate ancestry, merged-prerequisite and matching worker/review
   verification used by publication, under the project's dependency lock (git and
   network work never holds the project state lock; the readiness commit then
   requires the verified ledger to be unchanged). `task ready` still requires matching hosted-check/PR
   evidence. No operation automatically merges a PR.

## Safety boundaries

Dependency-lock ownership permits exactly the supervised calling run and excludes
other Orca writers on the branch: dependency actions and task-run preparation share
the project's dependency lock, and ownership is re-checked under the project state
lock at the start, at every ledger save and right before each push/create, so a
task change meanwhile refuses the action. This is **not** a universal lock over user
shells, external git clients, or other projects sharing a repository. Generic
bash retains user privileges: supported publication is runtime-gated, but Orca
cannot claim raw shell commands are universally prevented. Do not bypass the
supported task action with raw push/create.

The durable ledger's registration is authorization; readiness/UI labels are
not. Blocked/cancelled/closed/unknown attention stays fail-closed. The current
DAG models code prerequisites, not deployment attestations: no deployment
completion is fabricated from a merge. Stronger requirements must remain
explicit blockers until independently satisfied.

Protected `refs/orca/dependency-replays/*` and stack/checkpoint refs are retained
for recovery; source history is not deleted. Failed publication may leave a
pushed branch with no PR; retry `task publish` to reconcile. Original commits,
receipts and candidate refs remain available if adoption or persistence needs
manual recovery. Never force-reset dirty work or auto-merge a conflict.

Editable shipped prompts/tool descriptions route agents through these actions.
User edits are preserved; mandatory trusted contracts and new schema fields
remain effective. Role allowlists are unchanged. No live home migration,
service restart, runtime configuration edit, or deployment is part of this change.

Remote reconciliation validates the exact head repository/branch, base repository/
branch and recorded task PR number before push/create and after create (including
one-shot timeout recovery). Forks, wrong bases and ambiguous matches fail closed.
Origin identity, default branch/commit and clean head are checked again immediately
before each remote write. External users can still race after an observation:
GitHub and local git do not offer an atomic cross-system latest-default transaction.
This is not a universal guarantee against external races.

A saved replay receipt is **prepared**, not proof of adoption. A head equal to or
descending from the protected candidate is adopted; the original head or unrelated
history is refused before using the receipt's `onto` as a new replay base. The
receipt/adoption crash window requires explicit manual recovery; retry does not
automatically reset a branch or claim resumability.
