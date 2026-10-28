# Persistent numbered tasks

## Two-PR delivery

1. **Implement persistent numbered tasks** (this PR): durable SQL authority,
   migration and projection recovery, lifecycle/tool integration, Ctrl+T and
   confirmed merged-only removal, persistent cross-session task memory.
2. Layout, editable prompts/tool definitions and runtime-path work, **only after
   PR1 merges**. No runtime relocation, deployment or restart is part of PR1.

## Authority and scope

Global `memory.sqlite` contains durable `task_ledger_*` tables alongside the
rebuildable conversation archive. **Never delete or replace this database to
rebuild the archive.** Archive purge/sync only target their own tables; backfill
refuses to delete an old per-project database containing ledger records.

Each conversation/project retains its own immutable identity/repository binding,
UUID identities and monotonic project-local numbers. Sharing a repository does
not combine projects. Deleting/recreating a project under the same name fails
closed rather than adopting its old ledger. Explicit recovery is required.

The public record contains title, summary, number/UUID, creation time, individual
checkpoint times, four statuses (`queued`, `building`, `pr open`, `merged`),
dependencies and a PR link. Complete legacy ownership, branch, run attempts,
readiness, attention and history remain in private SQL safety snapshots. Existing
internal lifecycle states are not additional public statuses; merge/readiness
validation remains separate and is not weakened.

Numbers are allocated inside SQLite IMMEDIATE transactions while holding the
project state lock (never take those locks in reverse order; a project's dependency
lock, when needed, comes first). Reads use the existing ledger's read-only snapshot
without the project lock; only a first read that imports legacy records takes it. Legacy records are
sorted by creation time and UUID; migration preserves UUIDs and snapshots and
saves exact input bytes to `tasks.json.legacy-v1.backup` before importing. Duplicate
identities and conflicting backups fail closed. Import is transactional and
idempotent, with a retained project high-water mark and irreversible tombstones.

Archive `user_version` remains 2. Ledger schema has its own version, now 2, with an
incremental upgrade from the dormant version 1. Unknown versions are refused.

## Checkpoints and publication

Registration supplies queued evidence; only a supervisor-confirmed run start
supplies building evidence (not preparing or dispatching a run). Verified GitHub
OPEN observation supplies the first PR-open checkpoint, independent of CI or
readiness. A verified merge supplies the provider's merge timestamp; local merge
observation time remains in the private archive snapshot. Checkpoints persist
through retries, closed/reopened PRs and later observations. Import does not
invent missing timestamps or infer publication from readiness/chat plans.

## Recovery and compatibility

`tasks.json` is a compact version-2 membership projection, not a second authority.
SQL commits first; projection replacement is atomic. The next locked task read
repairs missing, corrupt or stale projections from SQL, including removals. If
projection writing fails, the API can report failure **after SQL committed**:
read the task before retrying. A prepared attempt can therefore be retained even
though dispatch never occurred; existing run reconciliation handles attempts
that never started. Registration retries should supply the same UUID.

Old task writers reject version 2. New code rejects a changed version-1 snapshot
after activation rather than overwriting SQL; the exact migration backup is
accepted only for recovery of the commit-before-projection window. Deploy
compatible readers/writers together before using this feature; stop old
processes before recovery. This PR does not perform that deployment or mutate
live databases/configuration/auth/locks. Back up the entire SQLite database with
a SQLite-consistent backup, not just `tasks.json`, before operational rollout.

## User operations and memory

Task tool register/get/list/dependencies accept stable project numbers where
appropriate; canonical dependency edges remain UUIDs. Title/summary are editable.
The tool exposes public fields separately from private dispatch/readiness details.
Ctrl+T includes merged tasks, retains navigation and `r`, polls automatically and
preserves selection. `d` asks for confirmation and only removes a verified merged
task's list membership; the SQL record, dependency edges and number are retained.
Visible PR URLs and OSC8 hyperlinks remain available (terminal gesture behavior
is terminal-specific; no physical Cmd-gesture verification is claimed).

Orchestrator `memory` (and compatibility alias `history`) supports `action: tasks`
for persistent cross-session lookup including removed records. Retrieval never
activates/imports projects or repairs projections. Read-only SQLite may recreate
missing owner-only WAL/SHM siblings using a read-write connection's read, without
writing database rows. Conversation indexing remains separately rebuildable.

Validation uses isolated temporary homes/SQLite and real App fixtures at 80/120
columns, not a live installation. Relevant checks and prior failures are recorded
in the implementation report; no full-suite or baseline comparison is required.
