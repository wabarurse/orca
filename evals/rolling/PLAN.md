# Pre-run protocol and budget

Baseline fetched/rebased to origin/main 3d08339 before inspection. No production edits.
Use only `accounts.provider("openai")`, model gpt-6-luna, low effort,
fast=false, no tools. First a single capability request (32 output cap, 30s).
If unsupported or unavailable, stop; do not substitute another model/account.
Then at most 48 summarizer calls, 2,400,000 estimated input tokens and
196,608 requested output tokens, 20 minutes total, 120 seconds per compaction.
No harness retries. SDK transport retries / one OAuth refresh on 401 may occur
within the deadlines; request budget counts provider.complete invocations, not
HTTP attempts. No new credentials or billing paths.

Two deterministic synthetic scenarios, 36 turns each (~8k estimated tokens per
turn), same turns in both arms; thresholds 100k and 50k, tail 20k. Alternate arm
order by scenario. Use production rollingCut and summarizeOlder (including its
180000-byte chunking, prompt, parser and 4096 output cap). At each turn estimate
retained foreground context; sum over identical turns. Preserve raw summaries,
usage and latency for every model call, not just compactions.

Simulation applies background work at the next turn boundary, assuming turns
are 180 seconds apart. It waits in wall time for the worker, not a live foreground
agent. This exceeds the production 30-second cooldown; no retries after failure.
No concurrent arrivals, task revision race, cancellation, images, history retrieval,
system/tool-schema overhead or foreground generation. These are explicit limits,
not end-to-end production or billing measurements.

Rubric: literal case-insensitive known-fact coverage separately in summary and
summary+tail; corrected values win. Report obsolete-value mentions separately
(they may be negated), completed task detail mentions and exact unsafe imperative
matches. These are deterministic lexical proxies, not semantic QA or a reliable
unsafe-action classifier. Keep full raw outputs for human audit. No dollars or
claim of measured foreground token billing. Failed pairs are not quality results.

## Pre-matrix correction
The first attempt stopped on its first summary: the fixture named a task but the
runner supplied an empty registry. Parser correctly rejected an unknown task.
That attempt is preserved in invalid-registry.jsonl; it is not a threshold result.
Supply the same authoritative blocked task in both arms and restart the entire
matrix. Deduct that one call / 61,878 estimated input tokens from the total budget
(47 calls / 2,338,122 remaining). No selective successful trial replacement.
