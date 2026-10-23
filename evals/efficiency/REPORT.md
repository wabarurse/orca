# Three production efficiency changes: before / after / CLI comparison

Implemented on `codex/harness-efficiency`, starting from current main `50a5ef9`.
Production implementation: `4bc0b6f`. The branch enables Claude prefix caching,
saves complete Bash output with adjustable bounded previews, and overlaps
explicitly independent tool calls with ordering barriers.

**The strongest benefits are Claude cache reuse, avoiding diagnostic reruns and
parallel waiting tools. GPT did not show a dependable general speed or token gain.**
On the four coding/inspection tasks, updated Claude Parallels averaged
31.7% less elapsed time and
74.1% less uncached input.
Total input changed only -0.9%:
caching is mostly an uncached-input benefit, not a smaller context window.

108 live trials were retained. The primary matrix has 90 matched trials and
**89/90 passed**; the sole remaining failure was an updated-GPT request that
waited for a model response until the 180-second evaluation timeout. Its cause
was not established. Full source/usage/command/workspace audits are saved below.

The original 90-trial matrix passed 86/90. Three repair attempts hit a conflict
between the orchestrator's delegation policy and the benchmark's direct-work
restriction. All 18 original repair trials, including successes, were retained;
the entire repair block was rerun for every arm with an explicit system-level
benchmark exception permitting direct repairs. All 18 corrected repairs passed.
Primary results use that full corrected block. This is a **workflow-normalized,
headless single-agent comparison**, not an unmodified multi-agent product benchmark.
See [method and correction](METHOD.md).

## Coding and inspection: 12 attempts per arm

Three repeats each of lookup, repair, source inspection and diagnostic-output
recovery. The artificial waiting workload is excluded from this table. GPT means
`gpt-6-astra`; Opus means `claude-opus-5-5`. Medium effort, fast off. Codex CLI
0.154.0 and Claude Code 2.1.307; subscription access throughout.

| Harness / model | Passed | Mean time | Median time | Mean total input | Mean uncached input | Cache reuse |
|---|---:|---:|---:|---:|---:|---:|
| Parallels before · GPT | 12/12 | 13.97s | 15.90s | 12,912 | 10,374 | 19.7% |
| Parallels after · GPT | 11/12 | 27.26s | 14.37s | 13,800† | 11,112† | 19.5%† |
| Codex CLI · GPT | 12/12 | 13.64s | 13.11s | 37,594 | 6,757 | 82.0% |
| Parallels before · Opus | 12/12 | 8.77s | 8.22s | 21,098 | 21,098 | 0.0% |
| Parallels after · Opus | 12/12 | 5.99s | 5.74s | 20,901 | 5,466 | 73.8% |
| Claude Code · Opus | 12/12 | 9.06s | 9.29s | 60,916 | 4,038 | 93.4% |

Input is cumulative provider input per task, including cache hits and cache writes;
it is not peak occupied context. Uncached input is total input minus cache reads,
not a dollar charge. † Updated-GPT token averages cover the 11 attempts with
complete usage; the timed-out request's usage is unavailable, not zero.
All 12 attempts, including the timeout, remain in its elapsed-time statistics.

Claude Parallels used much less total input than Claude Code and was faster in
this small sample. **Claude Code still had higher cache reuse and lower uncached
input**. Codex likewise had much higher cache reuse and lower uncached input than
updated GPT Parallels. A smaller prompt alone does not guarantee lower uncached
input or better latency. Three repetitions per task cannot establish broad
product superiority or reliably separate feature effects from service variation.

## What each feature actually delivered

| Feature | Observed result | Practical interpretation |
|---|---|---|
| Claude prefix caching | Coding cache reuse 0% → 73.8%; uncached input 21,098 → 5,466/task | Clear reuse benefit. Total context is almost unchanged; speed is workload/service dependent. |
| Saved output with adjustable previews | Both models ran the diagnostic twice before and once after, in all three repeats | Recover omitted evidence from the saved file without repeating the operation. |
| Bounded previews on Claude diagnostics | Mean input 22,535 → 15,323; returned tool-output bytes 16,464 → 4,149 | About 32% less cumulative input and 75% less tool-result text on this task. |
| Adjustable previews on GPT diagnostics | GPT requested the largest preview every time; input 12,571 → 13,124 | Saving output helped reuse, but did not reduce GPT context on this task; schema/metadata overhead outweighed trimming. |
| Independent tool overlap | Four two-second tools took about 8.1s sequentially → 2.0s concurrently | Clear tool-execution gain when the model marks independent calls. Ordinary coding did not automatically become four times faster. |

## Controlled parallel workload: 3 attempts per arm

Four separate read-only health probes, each with a two-second delay. All arms
passed 3/3 and honored the separate-command requirement. Parallels before peaked
at one active tool; after peaked at four in all six model trials.

| Harness / model | Mean end-to-end time | Observed Parallels tool span |
|---|---:|---:|
| Parallels before · GPT | 14.85s | 8.08s |
| Parallels after · GPT | 7.61s | 2.02s |
| Codex CLI · GPT | 10.98s | unavailable |
| Parallels before · Opus | 11.54s | 8.07s |
| Parallels after · Opus | 5.85s | 2.03s |
| Claude Code · Opus | 15.38s | unavailable |

CLI end-to-end timing includes model and startup time. Its public events do not
establish exact execution overlap, so no CLI tool-span/concurrency number is inferred.

## Per-task measurements

Each row contains all three attempts. The timeout remains in repository/after-GPT
time. Its token averages cover two complete-usage attempts; other rows cover three.

| Task | Harness / model | Passed | Mean / median time | Mean input | Mean uncached input | Mean peak input |
|---|---|---:|---:|---:|---:|---:|
| lookup | Parallels before · GPT | 3/3 | 9.69s / 4.91s | 5,001 | 3,294 | 3,000 |
| lookup | Parallels after · GPT | 3/3 | 5.63s / 5.49s | 5,275 | 4,677 | 3,134 |
| lookup | Codex CLI · GPT | 3/3 | 8.48s / 8.44s | 21,661 | 3,485 | — |
| lookup | Parallels before · Opus | 3/3 | 10.99s / 8.62s | 15,077 | 15,077 | 5,963 |
| lookup | Parallels after · Opus | 3/3 | 4.68s / 4.23s | 16,278 | 5,324 | 6,680 |
| lookup | Claude Code · Opus | 3/3 | 7.03s / 6.06s | 45,807 | 2,562 | 20,295 |
| repository | Parallels before · GPT | 3/3 | 17.96s / 18.75s | 23,375 | 20,601 | 8,448 |
| repository | Parallels after · GPT | 2/3 | 74.42s / 26.63s | 27,922 | 23,442 | — |
| repository | Codex CLI · GPT | 3/3 | 16.71s / 16.78s | 48,997 | 13,627 | — |
| repository | Parallels before · Opus | 3/3 | 7.98s / 8.20s | 27,360 | 27,360 | 10,468 |
| repository | Parallels after · Opus | 3/3 | 6.81s / 5.99s | 33,266 | 8,697 | 10,072 |
| repository | Claude Code · Opus | 3/3 | 10.69s / 10.79s | 81,864 | 10,177 | 28,296 |
| output | Parallels before · GPT | 3/3 | 8.82s / 7.60s | 12,571 | 10,864 | 5,317 |
| output | Parallels after · GPT | 3/3 | 10.23s / 10.43s | 13,124 | 13,124 | 5,551 |
| output | Codex CLI · GPT | 3/3 | 11.06s / 11.20s | 36,459 | 5,440 | — |
| output | Parallels before · Opus | 3/3 | 7.98s / 7.85s | 22,535 | 22,535 | 9,406 |
| output | Parallels after · Opus | 3/3 | 5.41s / 5.52s | 15,323 | 5,721 | 5,715 |
| output | Claude Code · Opus | 3/3 | 7.25s / 5.66s | 44,157 | 1,004 | 19,068 |
| parallel | Parallels before · GPT | 3/3 | 14.85s / 14.21s | 4,222 | 3,113 | 2,190 |
| parallel | Parallels after · GPT | 3/3 | 7.61s / 7.57s | 4,522 | 4,522 | 2,350 |
| parallel | Codex CLI · GPT | 3/3 | 10.98s / 11.00s | 20,981 | 2,805 | — |
| parallel | Parallels before · Opus | 3/3 | 11.54s / 11.54s | 8,153 | 8,153 | 4,263 |
| parallel | Parallels after · Opus | 3/3 | 5.85s / 5.82s | 8,725 | 4,597 | 4,593 |
| parallel | Claude Code · Opus | 3/3 | 15.38s / 12.12s | 38,160 | 1,227 | 19,332 |
| repair | Parallels before · GPT | 3/3 | 19.40s / 19.24s | 10,703 | 6,735 | 2,914 |
| repair | Parallels after · GPT | 3/3 | 18.74s / 18.74s | 13,587 | 7,315 | 3,287 |
| repair | Codex CLI · GPT | 3/3 | 18.28s / 18.84s | 43,260 | 4,476 | — |
| repair | Parallels before · Opus | 3/3 | 8.12s / 8.63s | 19,418 | 19,418 | 4,887 |
| repair | Parallels after · Opus | 3/3 | 7.06s / 7.10s | 18,735 | 2,123 | 5,044 |
| repair | Claude Code · Opus | 3/3 | 11.28s / 10.63s | 71,836 | 2,408 | 20,228 |

Codex exec does not expose per-request peak input. Missing usage remains null in
JSON. Output tokens, cache-write input, request/tool counts, observed tool-result
bytes, full timing ranges and paired ratios are in [summary.json](results/summary.json).

## Original matrix, before the repair workflow correction

These results preserve the policy refusals, rather than attributing them to a
feature or quietly dropping unsuccessful attempts. The same four coding/inspection
tasks are shown; the parallel trials were unchanged.

| Harness / model | Passed | Mean time | Median time | Mean total input | Mean uncached input | Cache reuse |
|---|---:|---:|---:|---:|---:|---:|
| Parallels before · GPT | 10/12 | 14.12s | 16.44s | 12,076 | 10,156 | 15.9% |
| Parallels after · GPT | 10/12 | 29.37s | 14.37s | 13,493† | 11,655† | 13.6%† |
| Codex CLI · GPT | 12/12 | 14.22s | 13.11s | 37,553 | 6,566 | 82.5% |
| Parallels before · Opus | 12/12 | 9.24s | 8.27s | 21,330 | 21,330 | 0.0% |
| Parallels after · Opus | 12/12 | 6.60s | 5.74s | 21,913 | 6,189 | 71.8% |
| Claude Code · Opus | 12/12 | 9.05s | 9.65s | 60,743 | 3,905 | 93.6% |

## Implementation and checks

Default Claude prefix caching can be disabled with `anthropicPromptCache=false`.
Tool concurrency defaults to four; calls without the independent flag are barriers,
and result order is stable. `toolConcurrency=1` restores sequential execution.
Normal output through 16 KiB stays intact; larger default previews use 4 KiB.
Per-call limits are adjustable up to the configured cap. Full outputs are private
files outside the repository; cancellation, timeout and output-cap termination
preserve explicitly partial artifacts. Per-command output, age and completed-file
storage limits keep the store bounded. See [configuration details](../../docs/REFERENCE.md#tool-efficiency).

Tests cover cache request parity and accounting, real-orchestrator concurrency,
barriers and result ordering, concurrent artifacts, byte/UTF-8 bounds, source-sized
reads, output ceilings, cancellation, retention and storage errors before execution.
TypeScript checking, the compiled build and all 49 focused feature/metrics tests
pass. An earlier full run passed 889 tests. The final 890-test run had 888 passes
and two failures: a queued-input UI race and a merge-test fixture-hook timeout;
both recurred in a targeted retry. The UI race also fails on the untouched baseline
(8 of 12 repetitions). The fixture timeout's root cause is not established. No UI
code, test assertions or timeout limits were changed to hide these failures.
Full validation records are in [validation.json](results/validation.json).

The frozen baseline matches all 146 tracked entries, including symlink targets.
Production code was unchanged across both run blocks; the only later source-file
change corrected test environment cleanup. See [source verification](results/source-verification.json).

## Evidence and limitations

- [Methodology, isolation, commands and reproduction](METHOD.md)
- [Raw original 90 trials](results/live.jsonl), [independent original audit](results/live.audited.jsonl)
- [Raw 18 direct repairs](results/direct-repair.jsonl), [direct repair audit](results/direct-repair.audited.jsonl)
- [Primary 90 audited trials](results/primary.audited.jsonl), [primary summary](results/summary.json), [original summary](results/original-summary.json)
- [Original environment](results/original-environment.json), [direct-repair environment](results/direct-repair-environment.json)

All trial workspaces, exact commands, provider responses, CLI events and transcripts
are retained locally under the artifact paths recorded in the results. Raw prompts
and responses are not committed. Two pre-inference smoke failures caused by test
credential-path isolation are retained separately, along with the passing smoke.

These are small local tasks, not a realistic large-project benchmark. No background
compaction, long-session retention, delegation or reviewer loop was measured.
Provider caches were not flushed; fresh processes may reuse warm prefixes.
Native CLI prompts, tool schemas, sandbox behavior, startup, account routing and
service conditions differ. The later direct-repair block also has different warm
cache/service conditions. Treat the measured speed differences as observations,
not guarantees; the parallel tool-span and diagnostic rerun reductions are the
most directly attributable behavior changes.
