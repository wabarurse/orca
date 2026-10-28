# Validation record

Validated on macOS with Bun 1.4.2. No live provider requests, installation or deployment were used.

## Focused checks

| Check | Result |
| --- | --- |
| TypeScript (`bun run check`) | Pass |
| Compiled CLI build and version smoke | Pass; loaded source/build ID is present |
| Config, architecture, prompts, definitions and Bash contracts | 41 pass, 0 fail |
| Adaptive evaluation: adaptive-workflows | 11 pass, 0 fail |
| Adaptive evaluation: files-processes-sandbox | 12 pass, 0 fail |
| Adaptive evaluation: stream-fidelity | 32 pass, 0 fail |
| Adaptive evaluation: provider-recovery | 28 pass, 0 fail |
| Adaptive evaluation: usage-attribution | 1 pass, 0 fail |
| Adaptive evaluation: delegation-ownership | 18 pass, 0 fail |

## Full suite and baseline

The full suite was run in separate checkouts with temporary fallback ORCA_HOME directories:

| Checkout | Passing | Failing | Additional errors |
| --- | ---: | ---: | ---: |
| Unchanged main, `ff65c8ecc5cbbafd319c3435cbdaf95f0357c279` | 1471 | 141 | 3 |
| Adaptive runtime, before final pause/summary/input edge-case fixes | 1547 | 77 | 0 |

All 77 failing test names in the adaptive run also failed in the baseline run. This is failure-name comparison, not proof of identical causes or absence of regressions. Three existing snapshot failures remain. Remaining failures span older TUI fixtures, installation/runtime layout, task evidence, and context/compaction tests. The full suite is still red and this PR must not be described as fully green.

The final pause/summary/input changes were validated with all six adaptive evaluation groups, the 41 contract tests, type checking and the compiled build; the entire suite was not rerun after those narrow changes.

Reproduce focused evaluation with `bun evals/adaptive/run.ts <output-directory>`; it saves a JSON result and a log per group. Full tests use `ORCA_HOME=<temporary-fallback> bun test`. Tests create their own temporary fixtures.

This run does not establish lower production cost, faster model task completion or parity with Claude Code/Codex. Live comparative evaluation and Linux bubblewrap execution remain unverified.
