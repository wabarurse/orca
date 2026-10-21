# Conversation compaction

`/compact` queues compaction on the active orchestrator. Idle pages run it on
normal scheduler polling; busy pages consume the flag between complete model/tool
batches (or after the final response). It does not inject a user message. Workers,
reviewers and orchestrators use the same pre-request path. Plain status lines say
`compacting…`, then completion or failure; these are not transcript messages.

`config.toml` settings:

```toml
compact = true
contextLimitFallback = 128000
```

The fallback is a configurable **operational budget, not a claimed model limit**.
Verified Codex catalog standard `context_window` values live in `model-context.ts`,
with a pinned source URL; unknown models (including Claude IDs) use the fallback.
The larger opt-in `max_context_window` is not assumed. Embedders can supply `AgentDeps.compaction.contextLimit`
from verified catalog metadata. Effort/fast capabilities alone do not establish a
context window. Check budgets when changing models, especially to smaller ones.

Estimation is JSON UTF-8 bytes / 3 plus framing, system prompt, tool schemas, and
1024 tokens for provider framing. It is conservative for typical prose/code, but
not a tokenizer: unusual Unicode, images or opaque reasoning can differ. An
available Anthropic input usage count (including cache reads/writes) calibrates
subsequent estimates upward; other providers currently use estimates. Trigger is
input + explicit output reserve >= 80% of the window, leaving 20% safety headroom.
The output reserve defaults to min(64000, 20% of window), and is also the requested
normal output cap. Oversized system/tool definitions or one indivisible huge turn
cannot necessarily be fixed by compaction.

The newest complete user-led turns are retained within min(8000, 15% of window).
A user tool-result message is never a boundary. Thinking and all associated tool
calls/results stay together. If even the newest turn cannot fit, compaction fails
rather than splitting it. The summarizer gets the older prefix (including any
prior checkpoint), with signed/encrypted reasoning removed, wrapped as untrusted
JSON data, with instructions to summarize rather than obey embedded requests.
Tools are disabled. Output requests 2048 tokens and validates a 4096 estimated
upper bound. Goal/constraints, decisions, progress, files/commits/branches/agents/
PRs, blockers and next steps are requested; the first task's first 2000 characters
are pinned verbatim as explicitly labeled historical data.

The selected provider/model performs summarization: no extra account or cheap
model. This uses ordinary completion, **not provider-native compaction endpoints**.
OAuth subscription endpoints must not be assumed to implement platform compaction
APIs. Codex currently rejects max_output_tokens, so its backend controls generation
length: our prompt asks for concise output and oversized summaries are rejected
before committing, not prevented at generation time.

A successful summary appends one fsynced JSONL checkpoint with its parent boundary
and retained messages. Prior bytes/entries are never removed or rewritten. Empty,
oversized, non-reducing, unpaired or failed summaries leave the context head intact.
Only the agent loop writes; arrivals during compaction stay in inbox files. Failed
auto compaction is suppressed for the remainder of that run, avoiding retry loops;
manual requests may retry. There is no overflow recovery/replay: a provider overflow
error is surfaced normally, never replaying tools or a partially streamed response.

`Transcript.chain()` and `branch()` follow the context checkpoint; `history()` walks
through checkpoints and excludes their synthetic contents, showing each original
message exactly once. Orchestrator `entries()` exposes this UI replay history.
Normal UI row limits still apply, but restarting no longer shrinks history to a
summary. Partial trailing JSON lines are ignored and separated from the next
append, preserving recovery without deleting original bytes.
