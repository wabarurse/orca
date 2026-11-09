# Execution lifetime and performance

Ctrl+C stops the selected conversation, including its orchestrator, workers, reviewers, foreground shell groups and supervised background commands. This applies from an agent view and from the clear confirmation too. A second Ctrl+C within two seconds exits the TUI. Other conversations keep their own lifetimes.

Command collection is bounded independently of process signalling. After the
parent exits, output pipes have a one-second EOF grace; inherited pipes that stay
open trigger cleanup and a bounded one-second drain. Timeout/cancellation also
end the wait if signalling fails or the child never exits. Recording stops retain
their two-second interrupt grace before forced cleanup. Partial output remains
available. Permission errors and unconfirmed cleanup are reported rather than
silently treated as success. Background records become `unknown`, emit a durable
event, and remain protected from cleanup/forgetting; their commands are not
automatically replayed. An OS-denied or escaped process can still need manual
inspection, but it cannot keep the agent's output collector waiting indefinitely.

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


## Read-only agent activity

`runtime({action: "status"})`, `/runtime`, the TUI running count and `/agents` share a point-in-time activity snapshot. A running agent needs a current launch matching its run record, a live agent PID and a live tmux pane. An agent with a verified-gone PID is exited; missing/invalid ownership, changed launches, permission errors, conflicting end records and unverifiable panes are unknown. Retained dead panes do not prove activity. Failed inspection produces a null running count and explicit errors, never a fabricated zero. `verifiedRunningCount` still reports the confirmed subset, and `observedAt` timestamps the snapshot; this is not an atomic guarantee that processes cannot change immediately afterward.

Agent rows include queued inbox-file counts and task ID/number/name only when the task owns that exact current run. A queued follow-up does not start or resume an exited agent. Queue read failures are null, not zero. Historical build/model/context records are returned separately as `contextObservations` and never establish liveness. Supervised command states remain recorded process observations. `applicationSchedules: "not_inspected"` explicitly excludes application cron, external schedulers and production toggles from this tool's claims. `all_projects` applies to usage only; status is scoped to the current conversation.

Inspection does not drain messages, update task stages, launch processes, repair identity, restart workers or trigger scheduling. No new polling loop is added; existing TUI checks use the shared snapshot, and their frequent count path does not read transcript bodies or restoration clocks. Unknown activity stays visible and is not offered as a finished row for removal. Existing cancellation, supervision and watchdog behavior is unchanged.

The footer preserves verified running counts when retained records are uncertain:
`1 confirmed agent running (1 unverified)` shows the confirmed subset and the unresolved
row separately. A failed inventory says so instead of presenting an exact total;
a failed refresh clears stale confirmations and displays `agent status unavailable`.
The runtime's exact `runningCount` remains null until verification is complete.

Pane queries explicitly target the session with `=session:` so a missing session
is not confused with a window lookup failure. PID checks use signal zero. On
`EPERM` only, a bounded ownership lookup can prove that a PID was recycled to a
different Unix user; agents launched by this runner use the current UID. Same-UID
or unreadable ownership remains unverified. Status inspection never signals or
rewrites a retained run, and genuine permission failures do not become zero agents.


## Feedback to workers that finish or exit

`message` is enqueue-only. Worker/reviewer recipients return an explicit receipt
with `enqueued`, `agentStarted: false`, `processingConfirmed: false`, observed
recipient activity and whether it is finishing. A safe same-branch/task resume
hint may be included for exited/finishing workers; stopped, cancelled, closed or
merged work does not get that hint. Inspection failure reports unknown without
turning a successful queue publication into a delivery error. A receipt never
authorizes a restart or proves work is in progress.

For already-authorized corrections or continuations, the orchestrator uses the
existing `spawn` handoff on the same unmerged branch/task. It queues to receptive
workers, waits for reporting workers to finish, or starts an idle worker with
its retained context/workspace. If the worker exits before consuming the queued
follow-up, that existing handoff resumes it on its queue. An unknown post-send
check reports queued/unverified and never starts a speculative replacement. A
worker that already consumed its input and exited is not described as continuing.

Direct human feedback from an agent view uses that same handoff, including image
attachments. Trusted human identity/image references travel through engine
context, not model-controlled tool arguments; ordinary model forwarding still
requires possession in its current context. Ownership and stop gates run before
delivery. Status questions never restart workers; new filesystem polling, cron,
automatic workflow phases or model-based retry loops are not introduced.

## Reusable provider prefixes

Role instructions and tool definitions form the reusable request prefix. Repository
instructions, available skills, selected knowledge and the working brief are named
reference sections. The loop records only changed sections as user-role reference
updates after existing history; these are not human input, authorization or inbox
receipts. `contextSnapshot` identifies internal entries for UI restoration, which
hides them. Their original bytes remain in the saved transcript and model history.
Unchanged sections are not resent as new messages after each tool or restart.

Anthropic uses an explicit five-minute cache boundary after stable system
instructions, in addition to automatic caching for the growing conversation. This
lets fresh conversations reuse the same tools/instruction prefix. An explicit
`anthropicPromptCache = false` remains respected. No cache warming requests,
background model calls or one-hour write policy are added.

Codex subscription requests use a `prompt_cache_key` and matching `session-id`
and `thread-id` headers. Codex derives ChatGPT cache affinity from the session
header; a body key alone did not improve reuse in the initial A/B cohort. The
key hashes a stable local transcript scope, model, role instructions and tools.
Raw paths, run IDs, timestamps, assignments and trace metadata are never sent
as the routing identity. The scope survives provider reloads and agent restarts. The subscription endpoint rejected public
API `prompt_cache_options` and `prompt_cache_breakpoint` fields during the isolated
compatibility probe, so production sends neither. Cache writes are recorded when
the endpoint supplies `input_tokens_details.cache_write_tokens`; missing values
remain unknown. Cached and cache-written tokens still count toward input context.

Compaction keeps the same triggers, output reserves, rolling summary algorithm
and tail budget. Its retained MessageParams can include reference updates without
entry metadata; the loop recognizes their complete marked sections and avoids
repeating them. Sections summarized out of the tail are restored once from current
knowledge before another request. Reference messages are actual model input and
therefore count toward the existing tail/request budgets. Clear boundaries seed
current context again; cancellation and ownership guards cover every publication.

The cache-focused before/after runner and endpoint probe are under
`evals/cache-prefix/`. They use disposable homes, generated fixtures and read-only
access-token snapshots; never install or update a live Orca home to run them.

The [2026-11-03 report](../evals/cache-prefix/REPORT.txt) records 60/60 audited
trials. On coding/inspection fixtures, cached-input share rose from 69.6% to
90.9% for Opus and 54.7% to 80.0% for Astra. Estimated list-price-equivalent cost
fell, while mean latency increased about 4%; this establishes no speedup. The
initial unsuccessful OpenAI body-key experiment, complete cohort rerun, naturally
warm cache conditions and unrelated baseline test failures remain disclosed.


## Waiting for validation

Use background Bash for long local tests and evals. Its terminal event includes
the exit status, a bounded output tail, and the artifact path. For hosted checks,
`process({action: "watch_pr", number, head})` runs one supervised watch per live
PR head within the conversation. Its owner receives completion and can report
back to other agents. If the PR head changes, the watch ends with a stale-head
result. A passing watch is an observation about checks on that commit. Review,
merge readiness, and publication decisions still use their own evidence.

Group independent discovery calls in one model turn. For known text paths, a
single `read({files: [...]})` accepts up to four file ranges with individual
revisions and continuation lines. Shared directory instructions appear once in
the batch response. Use a process output cursor for incremental log reads.

The existing `.runtime/usage.jsonl` records build IDs and tool-call counts on
model requests. A `response-latency` row for a consumed human input batch
records time from the oldest inbox enqueue to consumption, consumption to the
first model request, and model request to first emitted text or tool start.
Batches that end without a text or tool event record their outcome separately.
These are daemon measurements. They exclude time before durable inbox enqueue
and the client's polling/render delay. Use the build ID to compare similar
tasks before and after batching and event-driven validation.

Verification environments use the existing process supervisor and runtime maintenance tick. Merged worktree and settled-log cleanup run at most once per five minutes in a live daemon. See [verification sessions](VERIFICATION.md) for ownership and retention.
