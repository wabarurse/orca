# Task ledger stack — 1/7 (dormant schema)

No application imports or calls the installer. It takes an already-open connection;
this PR does not open memory.sqlite, upgrade runtime storage, import legacy tasks,
change UI/tool statuses, or make SQL authoritative yet. Future SQL authority lives
in the global memory.sqlite; project JSON lists become recoverable projections.

The shared LedgerTask is the canonical user record, stored as record_json rather
than duplicated mutable SQL fields. Identity columns are constrained projections.
The new status vocabulary is queued / building / pr open / merged; existing Task
and all current readers/writers are unchanged. `number` means stable project task
number; UUID dependencies resolve against retained SQL records, not JSON membership.
References are explicit strings, not dependencies inferred from chat or plans.

Private columns retain project/repository binding, revision, membership revision,
removal tombstone, legacy identity mapping and a separate safety envelope. Projects
remain conversation project IDs even when repositories match. Legacy imports must
retain complete Task snapshots (including branch, ownership, attempts, readiness,
attention and history); the safety envelope is not a second user status model.

Numbers exceed the retained project high-water mark, never reset or reused. Records,
identity mappings and project bindings cannot be deleted/reassigned by ordinary DML.
The later transactional allocator/importer must sort explicit legacy inputs
deterministically, persist mappings once, and fail on ambiguous identities. No
allocator, importer or graph validation is activated here. JSON shape validation,
UUID validation, first-reach immutability, optimistic revision checks and dependency
graph validation belong to that writer; DDL alone is not a public write API.

Checkpoint fields are individually optional, with no automatic timestamps. Retain
first evidenced reach even after status changes: queuedAt only with evidence,
buildingAt from earliest confirmed run start (not prepared launch), prOpenAt from
verified OPEN observation (never readiness), mergedAt from provider merge time.
Preserve local merge observation/archive time separately in safety metadata.
Missing legacy evidence stays absent; never substitute migration time.

## Compatibility and deployment gate

Archive user_version remains unchanged (currently 2): its incremental upgrades and
readers own that version and reject newer values. task_ledger_schema has an independent
transactional version (1); unknown versions and conflicting unversioned tables fail
closed. Future ledger changes must add ordered incremental steps, not recreate data.
Existing archive sync/purge only targets entries/tasks/entry_tasks/sources/meta and
cannot overwrite these separately named ledger tables. These tests simulate the
explicit SQL targeting without importing archive.ts or opening application paths.
File deletion/rebuild outside those functions is NOT safe once the ledger is active.

Before step 2 enables any write path, deploy compatible code to **all** processes and
audit every reader/writer, rebuild, cleanup, backup and database-file replacement
path. A dormant schema merge is not deployment or activation approval. No automatic
runtime upgrade is included. SQL commit + revisioned projection recovery must prevent
stale JSON from resurrecting removed membership; removing membership must retain the
record, number mapping and dependency resolution in SQL.

## Seven-PR sequence

1. **This PR:** shared model, isolated additive DDL helper and focused temporary-SQLite tests.
2. Task tool/lifecycle SQL writes and recoverable JSON synchronization, gated on schema
   deployment to all processes and reader/writer compatibility.
3. UI/tool four statuses and stable IDs, including verified merged migration.
4. `d`: merged-only confirmed JSON membership removal; ledger retention and SQL
   dependency resolution, no resurrection.
5. Memory tool cross-session queries including removed durable tasks.
6. Visible editable prompts/tool definitions actually loaded, safe permissions;
   executable code stays in app, skills reserved.
7. Runtime path migration with coordinated shutdown.
