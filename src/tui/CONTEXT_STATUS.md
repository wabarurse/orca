# Header telemetry

`Ctx ~12.3k/272k` is a conservative current-context **estimate**, not billing
usage or an exact tokenizer count. It uses the agent's actual safe-boundary
system prompt and tool specs plus the current transcript chain, including
checkpoint tails and context-clear boundaries, with the same UTF-8/image/framing
budget estimator used for compaction. Provider request totals are deliberately
not summed. The estimate is refreshed when the chain or request configuration
changes. While streaming it excludes uncommitted partial output.

`?` means unavailable: before this process's first request, after selecting a
model not matching its last request configuration, or in another agent's view.
Limits come only from verified model metadata, never the compaction fallback.
Unlisted models therefore show `?` for their limit. Agent views show both values as unknown rather than borrowing the project's
selected model or orchestrator usage.

`Review N` counts confirmed starts explicitly tagged `reviewMode: review` on
the task. `watch-ci` starts do not increment it and show `CI`. Legacy/unspecified
reviewer runs make the count unknown; prompt text is not heuristically classified.
The spawn tool accepts explicit reviewMode without breaking older callers.
There is no denominator: the configurable maximum is a flow instruction, not
an immutable task maximum, and corrections can reuse an existing task.

With multiple active task records the project has no authoritative focused task,
so the header shows the task count instead of guessing. Agent views match the
existing session/branch naming convention; ambiguous matches remain a count.
Task snapshots refresh on the existing header poll; failures show unknown.
Header geometry continues to clip to width and height budgets; on short screens
telemetry and model are prioritized over directory/remote details. The existing
footer running/queued/inbox statuses are unchanged.
