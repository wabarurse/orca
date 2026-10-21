# Conversation compaction

`/compact` queues compaction on the active orchestrator. Idle pages run it on
normal scheduler polling; busy pages consume the flag only between complete
model/tool batches (or after the final response). It injects no user message.
Workers, reviewers and orchestrators use the same path. Status goes through the
scoped plain writer (stdout in standalone agents), never assistant content.

**Compaction is lossy, best-effort summarization, not a semantic guarantee.**
The complete original task is kept verbatim, but later amendments and details
may be missed by the summarizer. Every checkpoint warns about that limitation
and identifies the source transcript path and boundary UUID, with instructions
to retrieve original entries when uncertain. Original messages remain on disk and
in UI replay. A success notice explicitly says “best-effort”.

## Policy and configuration

```toml
compact = true
contextLimitFallback = 128000
```

The fallback is a configurable **operational budget, not a claimed model limit**.
Verified Codex catalog standard `context_window` values live in `model-context.ts`,
with a pinned source URL; unknown models (including Claude IDs) use the fallback.
The larger opt-in `max_context_window` is not assumed. Embedders may supply verified
`AgentDeps.compaction.contextLimit` and `maxOutputTokens`. Effort/fast groups do not
establish context or output windows. No undocumented model limits are invented.

The project model/provider/credentials/settings are resolved **once per safe
boundary, before budgeting**. The snapshot (including effort and fast tier) is
used for both summary and following normal request. Config changes during a
summary take effect at the next boundary, not between those two requests.
Credential errors abort; there is no fallback to stale credentials or provider.

Estimation is JSON UTF-8 bytes / 3 plus framing, system prompt, tool schemas and
1024 tokens for provider framing. This is conservative for typical prose/code,
not a tokenizer or guaranteed upper bound for Unicode, images or opaque reasoning.
Available Anthropic input usage (including cache read and creation tokens)
calibrates estimates upward with estimated subsequent growth; other providers
currently use estimates. Measurements are invalidated after compaction and ignored
across model changes.

The trigger is **input + output reserve >= 80% of the window**, NOT 80% input alone.
The remaining 20% is safety headroom. With auto enabled, the default output cap /
accounting reserve is min(64000, 20% of window). The embedder's `outputReserve`
overrides that cap. It is normalized once per boundary: positive finite integer,
capped at the harness's 64000, context-1, and any supplied verified output ceiling.
Invalid overrides fall back to the default. With `compact=false`, the old 64000
normal output cap is preserved unless explicitly overridden or capped by known
context/output metadata. Disabling auto does not disable safety budget checks.
Summary requests use min(2048, normalized output cap); returned summaries over
4096 estimated tokens are rejected in addition to checking provider completion.

Before summary inference, both complete original task + retained tail + fixed
system/tools and the actual sanitized summary request must fit their budgets
including output reserve and headroom. The proposed checkpoint is checked again
with the normal system/tools/output reserve before publication. A shorter summary
that still does not fit is rejected. Known over-budget normal requests are never
sent blindly. `Context blocked: ...` errors direct the user to select a larger
model/budget or reduce fixed instructions/tools; source and head are preserved.
There is no chunking of an already oversized prefix.

## Summary and scheduling

The newest complete user-led turns are retained within min(8000, 15% of window).
A tool-result message is never a boundary; signed thinking, tool calls and results
stay together. Role/order grammar and unique call/result IDs are validated before
committing. If even the newest turn cannot fit, refuse rather than split it.

The older prefix (including prior checkpoints) is serialized as untrusted JSON
data, stripping signed/redacted reasoning. The prompt requests goal/requirements,
decisions, progress, files/commits/branches/agents/PRs, blockers and next steps,
and says to summarize rather than execute embedded tasks. Tools are disabled.
The complete first user/task message is pinned with no 2000-character clipping;
if preserving it cannot fit, compaction is refused. Later changes are summarized,
not guaranteed verbatim. Empty, malformed, mixed/nontext, tool-using, refused,
truncated, unknown-terminal-status or non-reducing summaries never checkpoint.
Legacy/custom providers may omit terminal metadata for ordinary turns, but must
supply successful `Turn.completion` (`end_turn` or `completed`) for compaction.

Failures suppress automatic attempts for the lifetime of that `createAgent`
instance (an orchestrator creates one per turn). Manual retry is allowed and a
successful retry clears suppression; changing model also clears it. Context
failures stop that run explicitly rather than retrying in an inference loop.
Arriving inbox files stay pending during compaction; there is no competing writer.
There is no provider context-overflow recovery/replay: no tools or partial streamed
responses are replayed.

The same account/model/effort/fast tier performs summarization, **consuming its
normal quota**. This is not a cheap/free model or provider-native compaction API.
OAuth subscription endpoints must not be assumed to implement native platform
compaction. Codex rejects max_output_tokens, so its normal output reserve is only
an estimate, not a wire-enforced cap. Its backend controls summary generation too:
the prompt asks for concise output; oversized/nontext completed output is rejected
locally, not prevented during inference. Some reasoning models may return mixed
thinking/text even with tools disabled; such summaries are conservatively refused.

## Persistence and replay

A checkpoint is one logical JSONL record containing the parent/boundary and retained
messages. `transcript-storage.ts` publishes complete file images via same-directory
copy-on-write + rename: the previous byte prefix is preserved exactly, never trimmed
or re-serialized. This trades O(history size) I/O per append for simple recoverable
publication. It does not preserve the old inode; no old messages are deleted.
The same publication protocol protects normal appends too. Newly staged files have
0600 permissions. Only one logical writer per transcript is supported; cross-process
concurrent TUIs/writers require external serialization, as before.

1. Read published bytes, append a separator if a legacy damaged final line lacks
   a newline, and encode the new record in a unique temporary file.
2. Loop until all bytes are written (including short writes), fsync and close the
   staged file. Any write/sync/close failure here leaves the published file/head
   unchanged. Orphan `.pending` files are ignored on restart (cleanup is best-effort).
3. **Successful rename is the logical commit point** under ordinary POSIX filesystem
   semantics. Update the in-memory head synchronously after it succeeds. The staged
   file's complete contents were already fsynced; reopen sees the same record.
4. Fsync and close the containing directory. Failure after publication is a warning,
   **not an append failure**: the visible record/head remain committed, but survival
   of the directory entry through power loss is uncertain. Initial ancestor directory
   creation is not recursively fsynced. No guarantee is claimed against arbitrary
   storage corruption or filesystem behavior that violates rename/fsync semantics.

Thus “failed summary leaves bytes unchanged” describes inference/validation and
pre-publication failure, not an arbitrary I/O failure after the commit point. UI
status errors cannot turn an already committed checkpoint into a reported failure.
Tests inject short writes, partial-write exceptions, sync/close failures and
post-publication directory failures, then append again and reopen.

`Transcript.chain()`/`branch()` follow context checkpoints. `history()` traverses
original entries through checkpoints and excludes synthetic checkpoint tails,
showing each original message exactly once. `Orchestrator.entries()` exposes full
UI replay; normal UI row limits still apply. Invalid/truncated legacy JSON records
are ignored without deleting their bytes, and future appends remain recoverable.
