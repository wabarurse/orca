# 100k versus 50k rolling compaction: bounded live pilot

## Recommendation

Keep production at 100k pending broader evaluation. 50k is promising for smaller
foreground context, but this pilot is not enough to justify changing the default.
It reduced estimated foreground exposure ~34.2% with almost identical measured
summary input, because **100k needed two model calls per compaction** whereas 50k
needed one. No production code or threshold was changed.

This is actual gpt-6-luna subscription inference, not fake-provider data. Baseline
was fetched and branch rebased to origin/main `3d08339` first. Existing signed-in
OpenAI account path only. Probe succeeded on 2026-10-23 (31 input / 5 output tokens,
1.120s). All committed content is synthetic; example.org URLs are fictional source
references, not verified policy evidence. No original private histories were read.

## Design and limitations

See PLAN.md for budget recorded before requests; fixtures.ts and run.ts are the
executable specification. Two 36-turn variants (“migration”, “incident”), 432,829
and 430,249 original estimated tokens. **These are near-duplicate scenarios** with
renamed components, not two independent realistic workloads. Diagnostics dominate
length; durable facts are sparse. This tests repeated carry-forward and amendment,
not dense long-running project histories. There is one sample per arm, no seed
control on model sampling, and no statistical significance claim.

Each arm receives exactly the same generated turns, 20k target tail, production
rollingCut, production summarizeOlder prompt/parser/chunking, low effort, fast off,
4096 output cap. Order is 100k→50k for migration and reversed for incident. Whole
retained messages can leave the tail below 20k. Trigger counts use the production
byte-based estimate, not provider tokenization; turns actually average ~12k
estimated tokens rather than the initial ~8k design estimate.

This is a synchronous discrete-boundary simulation, **not RollingCompactor lifecycle
execution**. We charge one foreground request estimate before each job and publish
before the next turn, with assumed 180-second turn spacing (greater than measured
job durations, 120-second deadline and 30-second cooldown). Thus no failed retry,
concurrent arrivals, registry revision race, or background overlap is simulated.
Production starts in background, preserves newer arrivals and may publish much
later; rapid real turns could materially reduce savings. No retries were requested
by the harness. SDK defaults may retry transport requests; HTTP attempts were not
instrumented. Registry contains the blocked task; completed schema-cleanup is only
a prose completion, not a real archived registry transition. Checkpoint wrapper
is abbreviated and omits production activeTasks projection; tail and summary
measurements exclude system prompts, tools, images and foreground response tokens.
No disk history-retrieval recall or foreground answering was measured.

## Exact run evidence and costs

Raw per-call text, usage, latency and per-turn metrics: results/live.jsonl.
Derived matching checkpoint metrics: results/summary.json. Fixture hashes are in
raw data; fixture generator is the committed source of truth.

| Scenario / trigger | Compactions | Model calls | Measured input | Measured output | Cached input | Summed latency (s) | Estimated foreground exposure |
|---|---:|---:|---:|---:|---:|---:|---:|
| migration / 100k | 4 | 8 | 246,399 | 766 | 0 | 20.289 | 2,243,438 |
| migration / 50k | 8 | 8 | 246,801 | 909 | 0 | 22.071 | 1,475,481 |
| incident / 100k | 4 | 8 | 246,423 | 746 | 0 | 15.859 | 2,230,262 |
| incident / 50k | 8 | 8 | 246,812 | 855 | 0 | 18.862 | 1,466,624 |

50k adds 791 measured summarizer input tokens (+0.16%) and 252 output tokens
(+16.7%) across both variants, with the same 16 calls. It saves 1,531,595 estimated
foreground input tokens (34.24%). Total latency increases 4.785s (13.2%); this is
summed worker latency, not user-facing wait time. Cache reads reported zero.
No dollar rates, billing or actual foreground usage are implied. Illustrative
break-even: savings require `foreground effective cost/token * 1,531,595` to exceed
`summary input cost/token * 791 + summary output cost/token * 252`, after converting
the foreground estimate to real tokenization and accounting for caching and extra
retrieval. Subscription limits are not necessarily token-priced.

At turns 12 / 24 / 36 retained estimated contexts were:

- migration 100k: 48,301 / 96,601 / 48,432; 50k: 48,300 / 48,467 / 48,443.
- incident 100k: 48,023 / 96,036 / 48,151; 50k: 48,018 / 48,172 / 48,153.

Final context alone misses the savings between checkpoints. Exposure sums the
same 36 pre-publication foreground requests per arm, not post-compaction sizes.

## Quality: lexical rubric and manual audit

The reproducible rubric in fixtures.ts checks seven known fact substrings at each
turn, separately in summary alone and full summary+retained tail. It detects
obsolete-value mentions, completed-task name mentions and two exact unauthorized
imperatives. These are **coverage/mention proxies**, not model answer accuracy;
negated obsolete facts are not contradictions, and arbitrary unsafe paraphrases
would be missed. There are no live QA calls or hidden judge calls.

All arms end with 7/7 coverage in both summary and retained context. At matched
turns 12 and 24 all arms have 6/7 summary coverage but 7/7 full-context coverage:
recent corrections live in the tail until the next summarization. Scoring summary
alone would incorrectly call these full-context memory losses. At turn 12 the
completed task name is still in the retained source, but not in summaries. Final
summaries contain no completed-task detail and no exact unsafe imperative matches.

Manual inspection of final summaries finds no contradictory current retention or
region decision: obsolete values are explicitly marked “replacing/replaces,” not
asserted as current. Final obsolete mention counts are migration 100k=1, 50k=2;
incident 100k=0, 50k=1. All preserve the blocked legal approval and no automatic
restart, no dashboard publication authorization, and source URL.

**Important post-hoc omission found by manual review:** the original seven-item
rubric forgot resolved escalation owner Mira. Migration 100k drops Mira; other
three arms preserve her. Therefore expanded final known-fact recall is 7/8 for
migration 100k and 8/8 for the others (also full retained context at turn 36: the
Mira source has left the tail). This small observed advantage for 50k is real in
these outputs, but not robust evidence from four trials. Raw data preserves this
failure; we did not rerun models or silently alter the preregistered score.

## Budget, correction and reproducibility

The first matrix attempt supplied an empty registry while mentioning audit-export.
The model emitted that ID, and production parser correctly rejected it. Preserved
in invalid-registry.jsonl; not a usable paired comparison. Fixed the fixture
registry, deducted its call and estimated input from the budget, restarted the
**whole** matrix. No selective retry of an arm. Corrected matrix: 32 calls,
1,595,204 estimated request-input tokens, 77.222s. Including invalid attempt:
33 summarizer calls, 1,657,082 estimated input; measured 1,024,760 input and 3,359
output tokens. Plus the separately budgeted probe. All below original caps.
No successful response was charged a fabricated missing usage value.

Commands (run from repository root):

```sh
bun install --frozen-lockfile
bun evals/rolling/probe.ts
bun evals/rolling/run.ts       # refuses to overwrite live.jsonl; archive explicitly
bun evals/rolling/summarize.ts # offline, no model calls
bun run check
bun test
```

For a rerun archive existing results first, authorize a fresh budget, and preserve
all failed attempts; provider sampling and cache/service conditions are not
reproducible bit-for-bit. The generator and offline scoring are deterministic.
Tests cover fixture determinism/length/tail, rubric corrections and registry.
Typecheck passes. First full suite: 1147 pass, 2 failures + one downstream error
in rolling-memory-integration ownership tests. Isolated rerun: 13/13 pass;
subsequent full suite: **1149 pass, 0 fail**, 8 snapshots / 20,388 assertions.
No production changes were made to hide the transient test failure.
