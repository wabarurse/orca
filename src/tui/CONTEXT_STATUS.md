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
New reviewer dispatches require explicit reviewMode; missing or invalid mode is
refused before launching. Production orchestrator instructions specify both modes,
including zero-review CI. Worker dispatches must not supply reviewMode. Legacy
persisted runs are retained unchanged and remain unknown.
There is no denominator: the configurable maximum is a flow instruction, not
an immutable task maximum, and corrections can reuse an existing task.

With multiple active task records the project has no authoritative focused task,
so the header shows a bounded distribution instead of guessing:
`Reviews 0r:2 1r:1 2+r:1 ?:1 CI:1`. The first four buckets count tasks with zero,
one, two-or-more, or unknown code-review rounds (exclusive); CI counts tasks
whose latest confirmed reviewer start was CI-only (overlaps those buckets).
Agent views match the existing session/branch naming convention and show that
task's exact rounds; ambiguous matches retain the distribution.
Task snapshots refresh on the existing header poll; failures show unknown.
Header geometry continues to clip to width and height budgets; on short screens
telemetry and model are prioritized over directory/remote details. The existing
footer running/queued/inbox statuses are unchanged.


## Adoption and rendering

This is a **new tool contract**, not a capability retroactively added to a live
session. Install/build this revision and restart the harness (and start a new
orchestrator session/request using its newly generated tools and production
instructions). An external host must also regenerate its exposed spawn schema
with `reviewMode` and pass it through. The orchestrator's `functions.spawn`
schema in the review conversation does not expose this field: that already
running session cannot send it, and merely changing prompt text is not a valid
substitute. Do not label such historical dispatches as known reviews. Update the
installation/tool schema before using reviewer dispatches under this contract.

Identical header poll snapshots do not schedule a redraw. Context estimates
are cached by transcript head, model and request-configuration identity: repeated
draws do not traverse or serialize the chain. On narrow screens an oversized
telemetry row stacks context/model/review; at short heights model and context
remain before the distribution. Agent identity precedes paths. Selection
completion/auto-copy remains the main-branch behavior; telemetry adds no copy
or selection ownership operations.
