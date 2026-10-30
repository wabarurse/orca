# Execution lifetime and performance

Ctrl+C stops the selected conversation, including its orchestrator, workers, reviewers, foreground shell groups and supervised background commands. This applies from an agent view and from the clear confirmation too. A second Ctrl+C within two seconds exits the TUI. Other conversations keep their own lifetimes.

The stop barrier is durable at `.runtime/projects/<project>/execution-stop.json`, scoped to the project incarnation. Stopping also changes the input epoch. Agents and commands retain the epoch they were admitted under, so a quick human resume cannot accidentally revive old work. Per-run admission records live under `.runtime/projects/<project>/admissions/`. Existing workers also receive their exact-run cancellation files, and commands receive stop files, for compatibility with processes still running the previous build.

Only a newly submitted human message to the orchestrator releases the barrier. Agent reports, process events, old queued messages, compaction, settings changes, reopening a TUI and update helpers do not release it. Daemon keepers and `orca pull` handoffs skip stopped conversations. A new message starts a fresh orchestrator process; it may delegate follow-up work using preserved history and workspaces. No worker is automatically restarted solely because it was interrupted.

The daemon's own watchdog/merge commands share a cancellation scope. Stopping aborts them as well as model work and background compaction. An ordinary TUI disconnect still preserves ongoing remote work; Ctrl+C is the explicit conversation stop.

## Idle work

Transcript refresh checks device, inode, size, modification time and change time before reading. An unchanged snapshot requires no lock or JSON parse. Changed snapshots and all publications still use the existing storage lock and atomic publication. Internal transcript lock events cannot wake the daemon's file watcher.

Process recovery uses active markers published before process state. Completed records with delivered events remain available for inspection but no longer take recovery locks every two seconds. Recovery initializes from existing records once per process, and cheap directory listings discover commands created by older builds that do not maintain active markers. Undelivered terminal events remain eligible for recovery.

State reads reuse a bounded pool of SQLite connections and prepared statements. Calls do not retain read transactions or cache row values: another process's committed changes remain visible. Ownership, link and file identity checks remain in place; permissions are changed only when they need repair.

## Context and requests

Worker and reviewer foreground compaction has a configurable `workerContextTokens` target, default 128000. The model's actual input capacity and output reserve can trigger compaction sooner. This is a working-context target, not a claim about model capacity or a lossy truncation limit. Complete tool batches, original history and existing checkpoint validation are preserved. Orchestrator rolling compaction retains its independent 25% trigger and 50k recent-tail target.

Rolling summaries can generate up to 8192 tokens, subject to a supplied model output ceiling, while accepted memory still must fit the existing 4096 estimated-token budget and item limits. The generation allowance includes syntax and any reasoning. Repairs retain the same system prompt and original source-message prefix and append a repair instruction, enabling provider prefix caching where supported. This does not guarantee a cache hit.

Completion requests coordinate HTTP 429 recovery by provider/profile through shared SQLite state. `Retry-After` controls scheduling when supplied; otherwise bounded exponential cooldown applies. Recovery probes are paced across processes, healthy accounts remain concurrent, and waiting is cancellable within the existing request deadlines. A provider lockout more than a minute away fails closed rather than holding a stream open. Profiles are independent; no fallback account or model is selected. Web-search calls retain their existing separate handling.

## Measurement

On 2026-10-30, a live 10-second sample showed eight idle orchestrators using approximately 121% CPU combined, plus 5% for the TUI. The comparison fixture below used a single daemon, a 7,252,466-byte synthetic transcript and 250 completed processes. It ran without model requests, GitHub calls or private project data. Both runs warmed for 1.5 seconds, then measured process CPU time over five seconds.

| Measure | Installed build c577460 | This change |
| --- | ---: | ---: |
| Process CPU time | 1444 ms | 27 ms |
| CPU as a fraction of one core | 28.9% | 0.54% |
| Idle checks | 99 | 5 |

This is an idle CPU regression measurement, not a battery-life estimate, a model-cost benchmark or a comparison against Pi. Provider latency, selected reasoning effort and workload remain separate factors. Foreground transcript publication still preserves whole atomic file images; this change optimizes unchanged reads, not that write path.

Reproduce with `bun scripts/benchmark-idle.ts` in a checkout, or pass a different source checkout as its argument. The script overrides `ORCA_HOME` with a temporary synthetic home and removes that fixture afterward.

## Pi reference

Source inspected: [earendil-works/pi, commit a14cdf90](https://github.com/earendil-works/pi/tree/a14cdf90f0a76532f3e20bc3c01872837cef24ba), formerly `badlogic/pi-mono`.

- [`Agent.abort` and `waitForIdle`](https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/agent/src/agent.ts) explicitly own the active run. [`AgentSession.abort`](https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/coding-agent/src/core/agent-session.ts) also aborts retries, compaction and branch summaries. Orca adapts that lifetime across its separate processes with a durable stop barrier.
- The [agent loop](https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/agent/src/agent-loop.ts) continues for tool work, steering, follow-ups or an explicit continuation decision, and settles when those are absent. This supports explicit execution ownership rather than turning filesystem maintenance into inferred new work.
- Pi's [summary generation](https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/coding-agent/src/core/compaction/compaction.ts) separates generation output from the context reserve. Orca applies that separation while retaining its own memory validation and limits.
- Pi is implemented in TypeScript. Its [tool truncation defaults](https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/coding-agent/src/core/tools/truncate.ts) are 2000 lines/50 KiB, larger than Orca's default 16 KiB result cap. Lightweight architecture does not mean simply making every output smaller, and these source comparisons establish no performance ranking between the harnesses.

The implementation comments identify the Pi ideas used here. No Pi source was copied, no workflow categories were added, and no language rewrite is needed to remove the measured idle overhead.
