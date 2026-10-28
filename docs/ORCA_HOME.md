# Orca home: layout 3

Layout 3 keeps the public home small and separates original evidence from rebuildable cache. It currently requires a **fresh home**. Startup refuses older layouts without modifying them. This PR does not reinstall Orca, reset an existing home, or provide a v2→v3 migration.

```text
~/.orca/
  prompts/                     # shared and role guidance
  tools/                       # editable tool descriptions/schema annotations
  skills/                      # personal skill catalog; bodies load on demand
  projects/<id>/
    tasks.json                 # current task projection; ledger in SQLite
    cache/                     # rebuildable data only
    transcript/                # original conversation/agent JSONL and companions
    tool-outputs/              # tool evidence; detailed worker reports in reports/
    images/                    # attachments and input metadata
  memory.sqlite                # project metadata, facts, working briefs, ledger/index
  .runtime/
    config.toml                # global configuration and pinned projects
    auth/{anthropic,openai}/    # private credentials
    app/                       # trusted installed application source
    layout.json                # layout version (3)
    activated                  # marks use of this layout
    projects/<id>/             # input history, input epoch, daemon, inbox, questions,
                               # runs, merge observations and supervised processes
    run-ownership/             # durable ownership/recovery records
    definition-defaults/       # provenance for editable shipped defaults
    usage.jsonl                # usage observations
    ...                        # tmux socket, locks, logs, scratch and recovery files
```

Entries appear as features use them. SQLite may place `memory.sqlite-wal` and `memory.sqlite-shm` beside the database. Transcript locks/heads and other transaction companions stay beside their transcript. These are part of the corresponding storage contract, not extra top-level categories.

## What must be retained

`memory.sqlite` holds repository bindings (canonical path, branch, worktree namespace), display names, model/effort/flow settings, user/project facts, the working brief's goal/decisions/result references, and the task ledger/conversation index. These are distinct tables/records; the state store does not take over archive schema versioning. Writes use SQLite transactions so processes cannot overwrite each other's updates. Invalid saved settings or corrupt databases are reported, never silently reset.

Project metadata is scoped to the project directory's incarnation. Deleting and recreating a name does not inherit the former project's repository authority, settings or decisions. Filesystem copies change that identity: copying a project folder and database is **not** a supported migration/restore procedure. Historical ledger rows and inactive state records remain retained. An offline restore to new filesystem identities needs explicit binding reconciliation.

`transcript/`, `images/` and `tool-outputs/` retain original evidence. `tasks.json` is the current-list projection backed by the SQLite ledger. `/clear` empties the active project's `cache/`. This directory may be deleted and regenerated; it must never hold the only copy of a binding, preference, decision, task or user message. The regression tests delete cache and reopen the project in another process to check this boundary.

`.runtime/` is **durable**, despite its name. It includes configuration, credentials, pending input/events, ownership records, supervised command output and recovery state. Deleting it can lose settings, logins and undelivered work. It is not a general cleanup target. Stop participating processes before making a consistent backup, and retain SQLite and any WAL/SHM companions together. No automatic age-based cleanup is introduced here.

Original repositories stay where the user put them. Git worktrees stay in the repository's sibling `<repo>.orca-worktrees/<namespace>/` directory. They are never moved into cache. The executable and shared installer lock remain under `~/.local/bin/` so different `ORCA_HOME` values do not split installer exclusion.

## Fresh setup from an older installation

1. Keep a trusted copy of the reviewed source outside the old home. Record the old executable/source revision for recovery.
2. Stop all processes using the old home, including daemons, workers, supervisors, TUIs and automatic launchers. Prevent old binaries from restarting during the change.
3. Preserve the old home as an offline backup. Do not remove its database, logins, transcripts or recovery files to make startup pass. An unused explicit `ORCA_HOME` is also suitable for a separate fresh setup.
4. Build/install the reviewed revision using the normal local installer, then start it with the fresh home. The first normal startup writes layout 3. Sign in again, reapply desired configuration, and open projects from their original repositories.
5. Verify launch paths select the intended build and home before resuming automatic launches. Keep the old home paired with its old version; do not point an old executable at the new home.

The bootstrap installer is for fresh destinations and downloads `main`; it does not install an unmerged PR or migrate a live installation. A fresh home intentionally starts with fresh conversation/settings state. There is no automated preservation upgrade to layout 3 in this revision.

`scripts/migrate-layout.ts` and its tests remain for historical **v1→v2** offline recovery. They move selected runtime entries and preserve their own journal/backups; their output is still rejected by layout 3. Do not treat that script as a current upgrade path or change a version marker to bypass the gate. Recover an old installation with its matching old version and recovery procedure.

## Editable definitions

Role/shared Markdown and tool JSON materialize on use. Prompt edits add local guidance while the trusted role/authorization contracts remain. Tool descriptions and field annotations are editable; schema structure, executors, allowlists and permissions remain compiled code. Adding a tool file does not mount executable code.

Defaults refresh only when a file still matches its recorded shipped content. User edits remain. Invalid definitions fail with an error; missing files regenerate. Definition files must be owned by the current user, regular, single-link, at most 128 KiB, and not writable by other users. Edit between turns: prompts/specs reload for a new orchestrator turn or agent start, not during an active request.

Skills are discovered from Orca's personal directory and supported repository locations. Their bodies load on demand through the skill tool; discovering a file does not execute it. See [adaptive runtime](ADAPTIVE_RUNTIME.md) for instruction precedence and the limits of personalization.

## Code ownership

- `src/config/paths.ts`: locations, project incarnation and repository metadata access.
- `src/config/state-store.ts`: private SQLite connections and transactional records.
- `src/config/config.ts`: global configuration parsing and defaults.
- `src/core/data/projects/`: model/flow validation, project locking and workspace behavior.
- `src/core/data/knowledge/`: facts, bounded working brief and selected context.
- `src/core/data/sqlite/` and `transcripts/`: ledger/database utilities and transcript pairing; callers import these owners directly.

Memory lookup can open SQLite connections and create/chmod SQLite companions. It is not claimed to be strictly filesystem-read-only. Existing ledger and publication authorization checks remain in place.
