# Runtime layout: upgrade boundary requiring a decision

Status: blocked design investigation, not the implementation of PR2. Do not
publish this commit as “Expose editable Orca definitions in a simpler layout”.
Inspected base: `1882f07` (origin/main after PR156).

## Concrete compatibility gap

A layout-version check added to the new executable cannot gate an already
installed old executable, an old development checkout, or an old process that
later spawns a child. Existing startup has no shared layout-version handshake.
`src/core/tmux/runner.ts:cliCommand` intentionally re-enters the exact current
executable. Updating the installed executable is not proof all participating
processes have changed versions.

`src/core/data/projects/state.ts` locks at root-level `checkout-locks`,
`turn-locks`, and `project-locks`. The last uses mkdir with no owner record.
`src/config/config.ts` places daemon locks and the tmux socket at root and
channels, runs, inboxes and questions within projects. Moving these paths alone
allows an old and new process to acquire different locks for the same resource.
Checking absence of locks before moving is not exclusion: an old process can
acquire one immediately afterwards. Age is not evidence an owner is dead.

Installation also has a different trust boundary: the existing shared
pull/install lock is `.orca-install.lock` beside the executable in the bin
directory (`src/core/install/installation.ts`), not under ORCA_HOME. Replacing it
with a runtime-home lock loses mutual exclusion with the old updater and may
split exclusion between different ORCA_HOME values targeting the same binary.
It must remain a compatibility barrier until an explicit retirement boundary.

## Decision needed before implementing migration

Choose an enforceable deployment boundary, not simply a “yes, stopped” flag:

1. **Externally enforced offline upgrade**: the operator prevents all launches
   of old binaries and source checkouts under this account during migration and
   prohibits their subsequent use against the migrated home. Specify the
   external mechanism and make that an explicit deployment prerequisite. The
   migrator still refuses any live or unknown owner; ownerless project locks
   require separate operator investigation, never automatic deletion. A process
   scan alone cannot enforce this boundary or prove its continued existence.
2. **Compatibility barriers at legacy paths**: retain old lock/socket/storage
   entry barriers that old clients cannot bypass, while new clients use the
   runtime layout. This relaxes the requested clean root. Each legacy access
   path (including direct memory writers, project creation and the bin-local
   updater) must be accounted for; a single layout marker is insufficient.
3. **Previously deployed handshake**: deploy a compatibility release to every
   participant before activating migration. This conflicts with the requested
   two-PR limit if it requires a third PR. Do not silently choose it.

An offline command can implement journaling and rollback once this boundary is
agreed, but those mechanisms do not solve old/new concurrent ownership.

## Required implementation after the decision

Keep config, memory.sqlite and its adjacent WAL/SHM, and private auth untouched.
Preserve tasks membership, repository binding and durable ledger evidence.
Classify project internals individually; do not move legacy repo/worktrees as
though they were disposable runtime files. Reserve skills without executing it.
Use a durable migration journal and permission-preserving staged copies with
verification/backups; do not rely on cross-device rename. Never copy a live
SQLite database as an offline backup. Retain rollback material and make partial
migration refuse startup until resolved. Do not remove unknown/live locks.

Visible prompt/tool definitions and shorter TASK/MEMORY descriptions remain
part of the same complete PR2, not a separate partial delivery. No application
code or definitions have been changed by this investigation, so no description
counts, loader tests, migration tests or TypeScript checks are claimed.
