# Rolling compaction: capped 100k versus total-window percentages

## Answer and scope

The rolling implementation evaluated here uses **a fixed 100,000-token target, safety-clamped**, not a fixed fraction of a model window:

`min(100000, 0.8 * (0.8 * window - outputCap))`.

Percentages below replace only `100000` with `fraction * TOTAL context window`; they do **not** mean fraction of input allowance or remaining capacity. Both the existing clamp and 20,000 retained-tail target stay unchanged. With default output budgeting, `outputCap = min(64000, 0.2 * window)`. The inner 0.8 reserves headroom for the input-plus-output budget; the outer 0.8 triggers earlier than that safe input ceiling. Fixed system/tool overhead also contributes to the trigger budget.

| Total window | Output cap | Safe input | Trigger safety ceiling | Current | 10% | 25% | 50% |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 272,000 | 54,400 | 163,200 | 130,560 | 100,000 | 27,200 | 68,000 | **130,560** |
| simulated 1,000,000 | 64,000 | 736,000 | 588,800 | 100,000 | 100,000 | 250,000 | 500,000 |

Thus 50% of 272k nominally means 136k, but effectively triggers at 130,560. Current 100k is ~36.8% of 272k and 10% of 1M; on smaller windows the clamp can lower it. **This does not establish any Opus context limit or billing behavior.** `src/model-context.ts` has no Opus entry. Unknown models use the configured context limit/fallback, otherwise **128k**, not an inferred 1M. At default 128k, output cap is 25,600 and the current trigger would clamp to 61,440. No production/default/model-table changes were made.

### Original live provenance and corrected validation base

The live run was made on **stale base `9ecfdb0d8bd113923797c3e32ae8585c5123e2c1`**, which lacks rolling modules. The original eval commit was `8d83f51a084160fe6184d24fd1187d44ddd1995a`. Calling that base the current default branch was incorrect. Before first review, `git fetch origin main` resolved actual current main to **`3d083396c192eefdeeeb43d791df6d01c1af7984`**, which **does include rolling compaction**. The eval-only commit was rebased onto that main; no other worktree was accessed and no production files were changed.

For the original live run, eval-local copies came from git objects at PR84 commit `3cdb69893332addbcd31d34deaf2d01916c44073`: production summary/parser/180k-byte chunker, cut and memory wrapper. Imports were redirected and the historical-message adapter asserted string-only input (the identical string-message path). No prior eval results were copied. These historical details describe the actual live run, not the corrected checkout.

**The corrected runner and offline replay now import `summarizeOlder` and `parseMemory` directly from `src/rolling-summary.ts`, and `rollingCut` directly from `src/rolling-memory.ts`.** The eval-local summary/cut implementations were deleted. The production summary uses the real production historical-message sanitizer. `taskSnapshot`, budgeting and estimates also come from production. `memoryText` is private in production, so `memory-text.ts` retains only that exact wrapper copy; an offline source-parity test verifies its function body against production. There is no intentional wrapper-text difference and no production export was added just for the eval.

The production rolling-summary and rolling-memory files are identical between the provenance snapshot and fetched main (`git diff 3cdb698 3d08339 -- src/rolling-summary.ts src/rolling-memory.ts` is empty). More importantly, **offline replay through current production functions matches all 58 recorded requests, raw-result parsing, published memories, cuts, checkpoints/context hashes, scores and totals exactly**. Timing fields are excluded from deterministic equality. The raw gzip, planning artifact and generated summary JSON remain byte-for-byte unchanged. No live/model calls were rerun or authorized during this correction. This establishes parity for the recorded text-only stream, not images, live background lifecycle or other untested inputs. All original scheduling/rubric limitations remain.

## Bounded design, before calls

See `PLAN.md` and `results/plan.jsonl`. One coherent deterministic audit stream, **110 turns, 548,080 estimated original tokens**, evaluated at ten identical checkpoints (11,22,…,110). The stream actually exceeds the largest 500k threshold. Facts are sparse amid repetitive synthetic evidence, but cover owner from the outset, later owner/region/retention corrections, publication non-authorization, legal blocker and no-restart rule, unresolved rollback question, policy URLs, external advice not authorization, and completed cleanup evidence (PR, verified-head-shaped identifier, passed checks), with a standing checksum decision surviving completion.

Each turn contains about 5k estimated tokens; each checkpoint adds about 55k. This coarse schedule bounds cost and is **not** a simulation of triggering on every production turn. The 27.2k threshold overshoots before its first opportunity. Summaries publish synchronously at checkpoints, with one estimated foreground exposure counted before publication and none between checkpoints. There is no foreground inference, background concurrency, overlap, stale-publication, 30s cooldown, user-interruption or live lifecycle test. This evaluates content reduction and serial summary work under a declared schedule, not end-to-end latency or production scheduling.

Six distinct effective thresholds are each sampled once. The same 100k trajectory maps to current/272k, current/1M, and 10%/1M because all other simulation inputs are identical. These are not independent observations. The planning note guessed 68k and 100k might share schedules; **the actual retained-tail overhead made that guess false**, and neither was deduplicated. 68k triggers nine times versus five at 100k. Only identical 100k policies share results.

Production cut semantics retain complete message/tool groups under a **target** of 20k, not exactly 20k. This fixture leaves roughly 15k of verbatim tail; estimates summed per group include repeated framing overhead. Production text summary source is split into 180,000-byte chunks, each merging its previous memory. Large thresholds therefore mean fewer jobs, not necessarily fewer model calls.

Pre-call dry run with 7,200 padding characters reserved 58 calls / 3,413,854 estimated inputs / 237,568 requested outputs. Live guards allow at most 64 attempts / 4M estimated inputs / 262,144 requested outputs / 20 minutes matrix wall / 120 seconds per multi-call job. Failures reserve budget; there are no harness retries, model/account changes or fallback inference. The existing configured OpenAI/Codex provider was used: **gpt-6-luna, low, fast=false**, 4096 requested outputs per call, exactly as `summarizeOlder`. No additional account was created.

## Observations

All 58 calls completed, zero recorded failures. Matrix wall time **184,730ms**; longest whole summary job **24,331ms**. Inputs estimated by the production UTF-8 bytes/3 heuristic: **3,296,470**; provider-reported inputs: **1,971,630**; provider-reported outputs: **7,254**; cached inputs reported: **0**. Requested output budget was **237,568**, not actual generated output. Request estimates exclude provider-internal serialization/instructions; measured usage remains separately recorded. Full provider-adapter requests/results/usage, not HTTP packets or hidden reasoning, are preserved in `results/live.jsonl.gz` (deterministic gzip, no credentials).

| Effective trigger | Summary jobs | Calls | Estimated summary input | Measured input | Measured output | Sum call latency ms | Estimated exposure | Final context estimate |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 27,200 | 10 | 10 | 561,083 | 335,691 | 1,305 | 47,542 | 697,863 | 15,451 |
| 68,000 | 9 | 10 | 560,474 | 335,271 | 1,227 | 25,644 | 737,131 | 15,472 |
| **100,000 current** | **5** | **10** | **559,011** | **334,342** | **1,286** | **33,061** | **956,436** | **15,425** |
| 130,560 | 3 | 9 | 500,978 | 299,584 | 978 | 25,066 | 1,160,234 | 70,234 |
| 250,000 | 2 | 10 | 557,894 | 333,611 | 1,258 | 28,795 | 1,732,159 | 15,445 |
| 500,000 | 1 | 9 | 557,030 | 333,131 | 1,200 | 24,318 | 3,025,392 | 15,467 |

“Exposure” sums production context-budget estimates at the ten pre-publication boundaries, including empty system/tools and fixed 1024 reserve. Final context is message-only estimate. These are neither actual foreground tokens nor savings. 130,560 leaves an extra interval unsummarized at the final checkpoint, so its smaller summary workload is not a matched-final-compaction advantage. Threshold-order execution is not randomized; latency varies with provider conditions and cannot establish a causal speed improvement.

For an explicitly hypothetical token-price illustration, if input costs `P_in` and output costs `P_out` per million tokens, current-summary work would be `0.334342*P_in + 0.001286*P_out`; 500k-summary work would be `0.333131*P_in + 0.001200*P_out`. This is arithmetic on reported usage, **not actual subscription charges**, a quoted price, foreground savings, or an Opus cost estimate. Foreground pricing, cache behavior and generated outputs were not measured.

## Fidelity and rubric

`results/summary.json` includes every matched checkpoint and every published memory. The predefined lexical rubric has nine facts initially and ten after the standing decision arrives. Summary-only and full retained-context scores are separate: no summary yet is logged as zero hits, **not** a failed retained history; a stale summary can be superseded correctly by its verbatim tail.

* At **68k**, Mira disappears at the first publication (turn22). Both summary and retained context miss the owner at turns22,33,44,55,66. The turn67 restatement restores her by turn77; the later Niko correction is retained. This is an observed loss, not hidden by final-only scoring.
* Other arms have no missing lexical facts in full retained context at the ten checkpoints. Current 100k's summary alone misses the new region at turn77 and owner at turn99, while raw recent history contains those amendments.
* All six final memories have 10/10 lexical hits, preserve Niko, eu-north-1, 30-day retention and policy-v2 URL, non-authorized publication, legal approval blocker, no automatic restart, unresolved rollback, and the checksum-verification standing decision. Manual inspection of final memories confirms these meanings, not merely their words.
* No final summary retains cleanup PR/head/debug details. Their removal is intended by the production instruction/authoritative merged registry, **not evidence that the model preserved completed-task proof**. Raw fixture retains that evidence for retrieval; no actual retrieval behavior is tested. Registry snapshots contain the completed task when relevant but exclude it from the active-task wrapper after merge.
* Some summaries correctly mention superseded Mira/eu-west-1. The obsolete-mention diagnostic cannot distinguish correct correction history from a stale current fact. Conversely the “14 days” lexical check misses “14-day”: final 27.2k memory explicitly says the old policy is superseded but the diagnostic does not flag that mention.

Limitations are substantial: exact substring scoring misses paraphrases, negation, attribution, relational errors and silent extra hallucinations. “checksum” can also occur in diagnostic filler, masking absence of a standing checksum rule in full-context scoring; a test locks in this known limitation rather than silently upgrading the posthoc rubric. Final-memory manual inspection checks the actual standing decision. Registry text can supply blocker hits even when a summary omitted them. The rubric checks owner presence, not that it is stored under the right section (500k puts escalation owner under `user`). External-source URL fidelity and completed-proof handling are represented in source and manual review, not a comprehensive automated semantic rubric. No adversarial safety claims follow from passing lexical hits.

**Conclusion:** this bounded stream shows larger thresholds reducing the number of summary jobs while chunking keeps total summary inference work similar; estimated foreground exposure grows. One intermediate arm loses the owner temporarily. It does not establish an optimum, monotonic fidelity trend, independent-sample replication, causal generalization or justification to change defaults. It does show why a fixed 100k cap can be conservative relative to a hypothetical 1M window, and why “50%” must retain safety headroom.

## Reproduction and validation

Offline, with no provider calls:

```
bun install --frozen-lockfile
bun evals/rolling-percentages/replay.ts
bun test evals/rolling-percentages
bun run check
bun test
```

`replay.ts` feeds saved raw responses through the exact summary/parser/cut pipeline, checks every generated request hash, every checkpoint/context hash/score and totals, and regenerates the report data. Aggregation rejects partial matrices, failures, absent/nonfinite usage, request corruption and budget/count mismatches. Tests mutate records to demonstrate rejection. Fixture generation, rubric and policy arithmetic are deterministic. Timing is retained from live data, not asserted as deterministic during replay.

`bun evals/rolling-percentages/run.ts --dry` is the no-provider planner. `run.ts` without `--dry` performs real inference and refuses to overwrite either existing raw JSONL or gzip. Do not rerun live without new authorization/budget; this report uses a single run. All artifacts are eval-only. No PR publication or production changes.

Original stale-base validation was targeted **6 passed**, TypeScript passed and full **916 passed** (70 files); those counts do not describe current main. Corrected validation on base `3d083396c192eefdeeeb43d791df6d01c1af7984`: production-backed offline replay passed, targeted suite **7 passed**, `bun run check` passed, full suite **1,153 passed, 0 failed, 8 snapshots** (85 files: main’s 1,146 plus 7 eval tests). `bun install --frozen-lockfile` on the corrected base made no changes. An initial check lacked installed dependencies; `bun install --frozen-lockfile` resolved it without lockfile changes. Initial eval-test assumptions about summed framing and checksum lexical specificity were corrected; both limitations are now explicitly tested/disclosed. Planning used 7,200 padding characters, not the initially proposed 8,000; it is a bounded overhead probe, not a formal worst-case proof. The live per-attempt guards, and verified completed live totals, enforce the hard limits regardless.


Preserved artifact SHA-256 checksums (also compared directly with original eval commit):

```
b1811230ed4c94dc80894c67a1bf51c9aa3bff695f24245b5ed06848e873ca86  results/live.jsonl.gz
3af7b5fdef20ae97d8122f843718e65bdd1ac01e8b83a2f40a368179abbccd3b  results/plan.jsonl
e2cdaeba47464eb7bf88e6de1fa42afffc289eb9392360208294edcdb657eaee  results/summary.json
```
