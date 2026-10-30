# Header telemetry

`ctx ~12.3k/272k` is a conservative current-context **estimate**, not billing
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

The header shows context, project/account/model and workspace identity. It has no review-round or dispatch setting and performs no flow-settings polling.

Task review bookkeeping is unchanged: confirmed `reviewMode: review` starts
count toward actual task rounds, `watch-ci` starts do not, and legacy starts
retain their unknown status. Task records remain the source of that progress;
it is no longer shown in the header.

Header geometry continues to clip to width and height budgets; on short screens
telemetry and model are prioritized over directory/remote details. The footer
running/queued/inbox counts are unchanged apart from lowercase labels.

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

Identical header snapshots do not schedule a redraw. Context estimates
are cached by transcript head, model and request-configuration identity: repeated
draws do not traverse or serialize the chain. On narrow screens an oversized
telemetry row stacks context/model; short screens prioritize those values. Agent identity precedes paths. Selection
completion/auto-copy remains the main-branch behavior; telemetry adds no copy
or selection ownership operations.


## Display case

App-owned labels, help, menus, statuses, errors, and displayed key hints use
lowercase prose. This is not runtime case-folding: user and assistant text,
code, paths, URLs, project/agent identifiers, model IDs and provider-returned
fields, and raw tool/subprocess errors keep their original case. Literal
commands, environment names (such as `PATH`), git refs (`HEAD`), key parsers,
and model prompts/tool schemas/protocol markers are also unchanged. Known tool
labels no longer gain title case; unknown tool identifiers stay verbatim.
