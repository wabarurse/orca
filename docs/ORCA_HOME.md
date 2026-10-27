# Orca home: editable definitions and offline layout upgrade

This is the second of two PRs; PR156 is the merged prerequisite. **No live
rollout, automatic migration, automatic merge, or configuration change.**
Existing installations must complete the manual offline procedure below before
starting this version. Fresh homes initialize layout version 2 on first startup.

## Layout and boundaries

```
~/.orca/
  config.toml
  memory.sqlite                # durable ledger + conversation index
  memory.sqlite-wal / -shm      # SQLite-managed companions, when present
  auth/                        # private credentials; not moved or rewritten
  prompts/shared.md
  prompts/{orchestrator,worker,reviewer}.md
  tools/<tool>.json            # descriptions and input-schema annotations
  tools/task-orchestrator.json # task's current-session history extension
  skills/                      # reserved, empty; NEVER scanned or executed
  projects/<id>/               # task list, repository binding, settings,
                               # transcripts/images and historical tool outputs
  .runtime/
    layout.json
    app/                       # trusted installed application, NOT user tools
    tmux.sock
    checkout-locks/ turn-locks/ project-locks/ daemon-locks/
    projects/<id>/{orchestrator,inbox,runs,questions,merged}/
    definition-defaults/       # last shipped default SHA-256 provenance
    migration.json             # durable progress/recovery journal
    migration-backup/           # retained copies; never automatically deleted
    activated                  # forbids rollback after compatible startup
```

The bin-local `~/.local/bin/.orca-install.lock` stays beside the shared
executable: different ORCA_HOME values must not split installer exclusion.
Transcript transaction locks remain adjacent to their authoritative transcript;
SQLite WAL/SHM remain adjacent to memory.sqlite. Historical tool outputs stay at
their old paths because saved messages contain those paths. Short-lived memory
backfill scratch directories remain at the database root. These are deliberate
boundaries, not disposable files to sweep. Git-registered checkouts/worktrees
are never relocated. The migration preserves each project directory's inode,
which is part of PR156's ledger binding identity.

## Effective definitions (data, not plugins)

Files materialize when that role/tool is first used. Defaults ship in the
trusted application. Role/shared Markdown contains the shipped templates, not
instructional copies of unused text. Every prompt construction reads them.
Changed text is prepended as local guidance; the current shipped role contract,
terminology, review flow and conditional dynamic-dispatch instructions remain
mandatory. Edits can add context/style but cannot remove the worker's reporting
contract, reviewer checks or authorization requirements. Unedited defaults are
not duplicated in the model prompt. Placeholder substitution is the same as in
the shipped template. Dynamic dispatch stays off unless already configured on.

Tool JSON contains `description` and `input_schema`. Edits to the main or input
field descriptions are loaded into the actual provider spec. Essential shipped
guidance is retained after edited descriptions. Schema **structure** (types,
required fields, enums, limits and property names) is intentionally immutable;
unknown keys or capability/schema changes fail closed, rather than creating a
new tool or silently being ignored. This supports effective editable input
*documentation*, not user-defined validators. Executors, role allowlists,
identity checks and permission enforcement remain compiled trusted code.
Adding a file never mounts a tool. No JavaScript, shell, skill, or project-local
override is loaded. TASK retains its current-list role; MEMORY/history are
orchestrator-only retrieval aliases, not competing task managers.

Precedence: shipped defaults → valid global user guidance → mandatory trusted
contracts. The SHA-256 provenance records the last materialized shipped content.
If the file still matches it byte-for-byte, a later default replaces it. Otherwise
user edits remain untouched. Missing files reset to current defaults. If an
edited old schema conflicts with a newer trusted schema, startup/turn creation
refuses: retain the edited file under a different name, let Orca regenerate the
new definition, then reapply description edits. There is no silent fallback.
Files must be owned by the current user, regular, single-link, at most 128 KiB,
and not group/world writable; definition directories cannot be symlinks.

Reload: orchestrator prompts/specs load at each new turn; worker/reviewer
prompts/specs load at agent startup. No in-flight mutation or executable reload.
An editor racing a shipped-default refresh is unsupported; edit between turns
or with the participating agents stopped. Keep copies of important edits.

## Manual offline operator procedure

**The script cannot prove shutdown or prevent old launches. The operator must
establish and maintain that exclusion. `--offline-acknowledged` records intent,
not a technical lock against old versions. Fresh agents alone are insufficient.**

1. Before downtime, obtain this compatible revision in a trusted checkout
   **outside** the home being migrated. Keep its absolute path. Ensure Bun is
   available. Do not run the old `orca pull` as part of migration. Keep an
   independent offline backup plan and sufficient space for the runtime copies.
2. Stop **every** orchestrator, worker, reviewer, daemon, TUI, updater, installer,
   and any other program using this home/database. Disable launch agents,
   terminal auto-starts and external supervisors. Close old development shells
   and prevent other users/scripts from invoking old binaries or source trees.
   Stop Orca's dedicated tmux server only after its agents have stopped. Inspect
   both root and runtime sockets/locks and the bin-local installer lock. A PID
   scan is supporting evidence, not proof or continuing exclusion.
3. Resolve every remaining lock separately. The script refuses **all** existing
   lock entries, even apparently dead owners; ownerless project locks are not
   stale merely because they are old. It never removes them or sockets. For a
   leftover socket/lock, independently verify shutdown/ownership, then quarantine
   it outside the migration paths, retaining evidence. Do not delete DB/WAL/SHM.
4. While launches remain prohibited, make the **dedicated installed app source**
   compatible too. Review its clean state and retain its existing revision for
   recovery. Update it to the reviewed PR2 revision using your normal trusted Git
   procedure (not a running old updater). Preserve its dedicated clone and
   receipts. This script moves that clone; it does not fetch/build/update it.
   Do not launch either version yet. Back up auth, database companions and
   project evidence offline as a consistent set if creating a full-home backup;
   this script's backups cover only the moved entries.
5. From the external compatible checkout, run the read-only plan, substituting
   actual absolute paths (no reliance on HOME/ORCA_HOME defaults):
   ```sh
   bun /absolute/compatible-orca/scripts/migrate-layout.ts \
     --root /absolute/home/.orca --bin /absolute/home/.local/bin
   ```
   Review every entry. Dry-run performs no writes. Missing/unsafe paths, mixed
   destinations, unresolved locks and cross-device trees refuse. Cross-device
   migration is **not supported** by this script: it refuses before moving,
   rather than guessing a copy/delete fallback. Use a separately planned offline
   copy/verify procedure if the plan reports this condition.
6. Keeping exclusion in force, explicitly apply:
   ```sh
   bun /absolute/compatible-orca/scripts/migrate-layout.ts \
     --root /absolute/home/.orca --bin /absolute/home/.local/bin \
     --apply --offline-acknowledged
   ```
   Originals are renamed on the same filesystem; copies are retained in
   `.runtime/migration-backup`. Journal updates and rename parent directories
   are fsynced. SQLite/auth/config/task-list files are neither opened nor moved.
   No automatic lock or history deletion occurs. Partial copies are never
   promoted as completed backups; an incomplete backup refuses continuation.
7. Install a compatible executable from the external reviewed checkout via
   its documented local installer, while still offline; installer bin-lock and
   receipt checks still apply. Verify PATH/shell aliases, launch configurations,
   executable receipts and every source launch path now select **only** this
   compatible version. The migrated installed source is `.runtime/app`, not
   `app`. Retire old launch paths and keep them prohibited after downtime.
   Do not just restart an old executable. Only then start Orca. Its version gate
   checks journal/layout consistency before any command other than help/version.

For a legacy `.parallels` home selected by existing read compatibility, pass that
actual root; the script does not rename the home itself. Migrated installed-app
lookup supports that legacy runtime location. Do not use the fresh-home bootstrap
installer for an existing installation. Non-default ORCA_HOME must be passed
explicitly and every home used by participating processes must be considered;
installed executable coordination remains bin-local, independent of ORCA_HOME.

## Recovery

Maintain offline exclusion throughout recovery. After an interrupted move,
rerun plan/apply with the same explicit paths. The journal lists every source
before any move; absence at source and presence at destination identifies a
completed atomic rename. Both present or neither present refuses. Completed
pre-activation apply is idempotent. If a backup copy was interrupted, retain it
under a separate quarantine name after inspection, then resume to make a new
copy. Never erase the only remaining source or backup to satisfy a check.

Before **any** new-version startup, rollback is available:

```sh
bun /absolute/compatible-orca/scripts/migrate-layout.ts \
  --root /absolute/home/.orca --bin /absolute/home/.local/bin \
  --apply --offline-acknowledged --rollback
```

Rollback renames original entries back, retains backups/journal and marks the
journal `rolled-back`. New-version startup and another migration then refuse
until a human inspects and archives the recovery journal/version marker outside
the runtime directory. Restore a compatible launch plan before lifting exclusion.
Rollback after startup is refused (`activated`), because new writes may need data
reconciliation. Do not remove that marker to force rollback. An interrupted
rollback still fails closed; rerun the same rollback while offline. Disk failure
or loss of primary data requires manual recovery from verified backups, not a
blind replay. The runtime backup is not a substitute for an independent backup
of SQLite/auth/history, and power-loss recovery cannot guarantee faulty storage.

## Short tool descriptions

TASK's main description explains current-list purpose, authorization/identity
and output; PR recording, ready, attention, removal and dependency details live
in the relevant fields. MEMORY explains cross-session use, when not to use it,
and untrusted evidence; action/input fields explain result paging and filters.
This follows [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents):
clear purpose, discriminable tools and explicit inputs/outputs, not length alone.
Memory lookup still uses PR156's existing SQLite behavior: no ledger row mutation,
but connection setup can create WAL/SHM and chmod files. It is **not** claimed to
be strict filesystem-read-only. No PR156 ledger/authorization checks were removed.
