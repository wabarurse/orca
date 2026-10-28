# Validation record

Validated on macOS with Bun 1.4.2. No live provider requests, changes to the real installation/home, deployment or merge were used. Installer tests use temporary homes and fixtures.

## Focused checks

| Check | Result |
| --- | --- |
| TypeScript (`bun run check`) | Pass |
| Compiled CLI build and version smoke | Pass; loaded source/build ID is present |
| Adaptive evaluation: durable-state | 4 pass, 0 fail |
| Adaptive evaluation: home-layout | 4 pass, 0 fail |
| Adaptive evaluation: adaptive-workflows | 11 pass, 0 fail |
| Adaptive evaluation: files-processes-sandbox | 12 pass, 0 fail |
| Adaptive evaluation: stream-fidelity | 32 pass, 0 fail |
| Adaptive evaluation: provider-recovery | 28 pass, 0 fail |
| Adaptive evaluation: usage-attribution | 1 pass, 0 fail |
| Adaptive evaluation: delegation-ownership | 18 pass, 0 fail |
| State/layout, input history, model switching and settings refresh | 60 pass, 0 fail |
| Final layout/migration CLI and owned-terminal fixtures | 17 pass, 0 fail |
| Bootstrap refusal cases and code organization | 18 pass, 0 fail |

The eight adaptive groups total **110 pass, 0 fail**. Storage cases exercise concurrent processes, transaction rollback, archive schema coexistence, corrupt/unsafe database refusal, project reincarnation, cache deletion, process restart, old-layout refusal and the public home structure. A delayed clear rollback cannot write old decisions into a replacement project.

The cleanup removes duplicate terminal fixtures and obsolete forwarding modules; organization checks enforce import direction, barrel ownership and file-size limits. Bootstrap checks cover existing configuration, layout markers and credentials before any clone. The compiled-app suite exercises relocated execution, login-free fake providers, worker exit handling, original-checkout reuse and installation into temporary homes.

## Full suite and baseline

The full suite was run with temporary fallback ORCA_HOME directories:

| Checkout | Passing | Failing | Additional errors |
| --- | ---: | ---: | ---: |
| Unchanged main, `ff65c8ecc5cbbafd319c3435cbdaf95f0357c279` | 1471 | 141 | 3 |
| Earlier adaptive runtime run | 1547 | 77 | 0 |
| Layout/organization changes, before final fixture/CLI-diagnostic corrections | 1562 | 71 | 0 |

The latest full run covered 1,633 tests in 130 files. Three failures were then repaired: the historical migration CLI's diagnostic-output expectation and two terminal fixtures missing the current layout marker. Those suites subsequently passed all 17 tests. The full suite was not rerun after these narrow corrections or the additional bootstrap fixture cases.

The other **68 failing test names also failed on unchanged main**. This is failure-name comparison, not proof of identical causes or absence of regressions. Three existing snapshot failures remain. Outstanding failures include older TUI expectations, task evidence, context/compaction and cross-provider fixtures. The full suite is still red and this PR must not be described as fully green.

Reproduce focused evaluation with `bun evals/adaptive/run.ts <output-directory>`; it saves a JSON result and a log per group. Full tests use `ORCA_HOME=<temporary-fallback> bun test`. Tests create their own temporary fixtures.

## Compatibility and measurement limits

Layout 3 requires a fresh home; older layouts are refused without modification. The historical v1→v2 migration utility is not a v3 upgrade. `memory.sqlite` and `.runtime/` now contain durable authority/settings/work and must not be deleted as cache. No actual home was migrated or reset during validation.

This run does not establish lower production cost, faster model task completion or parity with Claude Code/Codex. Live comparative evaluation and Linux bubblewrap execution remain unverified.
