# Conversation compaction

There are two compaction paths:

- **Orchestrator:** background rolling structured memory plus recent complete
  exchanges, backed by searchable original history (merged PR #74).
- **Workers/reviewers:** one bounded summary request over older history, a pinned
  complete original task, and recent complete turns/tool batches. Oversized source
  is excerpted locally; this path has no multipart inference loop.

`/compact` queues compaction on the active orchestrator and explicitly waits for
its worker at a safe boundary. Idle pages handle it on scheduler polling; busy
pages handle it between complete model/tool batches or after the final response.
It injects no user message. Status goes through the scoped plain writer (stdout
in standalone agents), never assistant content.

The TUI shows a persistent `Compacting…` animation above the input while memory
work is queued, running or being published. Typing does not dismiss it. Compaction
alone does not show `thinking…`; concurrent foreground model/tool work keeps its
own activity indicator. After a checkpoint commits, a one-time notice such as
`Compacted 302k → 65k` replaces the loader and clears on the next keypress.
These are estimated history-token counts, not billed usage. Reconnect restores
an active loader, but does not replay an old completion. Cancellation, failure or
daemon death removes the loader; failures retain the existing error notices.

`tui/footer/feedback.ts` is the reusable composer feedback area: owner-scoped text
or multiple lines, optional animation, and persistent or ephemeral lifetime.
It is presentation only. Daemon status carries independent foreground/compaction
activity and the last committed checkpoint ID/counts; existing polls publish
only changed snapshots, with no extra worker, inference, timer or status-write loop.

**Compaction is lossy, best-effort summarization, not a semantic guarantee.**
Recent verbatim entries override summaries. Original entries remain on disk and
in UI replay; retrieve details when uncertain. Worker checkpoints pin the original
task and identify the source transcript/boundary. Orchestrator checkpoints instead
carry three parts: the task ledger's current records and the saved user/project
preferences, both as saved, plus a model summary of the rest only (see
[REFERENCE](REFERENCE.md#orchestrator-rolling-memory)); they reference scoped
`task search_history`/`read_history` retrieval (current session only; the
orchestrator-only `history` tool searches earlier sessions and other projects, see
[REFERENCE](REFERENCE.md#the-history-tool-orchestrator-only)).

## Orchestrator rolling memory and history

`rolling-memory.ts` starts one background summarizer per orchestrator session at
**25% of the selected model's context window** (~250,000 input tokens on a 1M
model, 50,000 on a 200k model), or earlier if output reserves leave less safe
input capacity (`triggerTokens` overrides the fraction with an absolute number).
Workers and reviewers retain their existing foreground compaction policy. The old
absolute `orchestratorContextTokens` configuration key is ignored.

The orchestrator keeps roughly **50,000 recent tokens verbatim** (`tailTokens`),
never splitting a tool exchange, and always keeps the newest whole exchange even
if oversized. If the requested tail is at least the effective trigger (including
its safe-input cap), the tail target falls back to half that trigger, rounded down
and bounded at zero. Thus a 200k window targets 25k rather than retaining all 50k
at its trigger; the 128k fallback targets 16k. A 240k window still keeps 50k below
its 60k trigger. Explicit `triggerTokens`/`tailTokens` overrides remain supported,
subject to the same guards. Fixed prompt/tool overhead and a newest oversized
exchange can still leave no older messages to summarize; this is a tail target,
not a promise of a successful summary or a hard cap on indivisible exchanges.

The rationale is the cost-vs-recall experiment on branch
`experiment-rolling-compaction` (`out/compaction-experiment/REPORT.md`, 2026-10-29):
on one real 1,116-message transcript with a 1M window and opus-5-5 low summarizer,
25%/50k achieved 89%/78%/80% recall at the three checkpoints and carried 84.8M
context tokens over 552 turns. At the end, 50%/20k achieved 63% and carried
135.6M; 40%/100k achieved 74% and carried 121.2M. Those two had not compacted at
the first checkpoint (full-context recall was 100%), so 25%/50k did not beat them
there. Fixed 160k/30k carried less (60.2M) but had lower recall (72%/73%/61%).
25%/50k used the least summarizer input in this comparison; these single-corpus
results are not a general recall guarantee. The summarizer remains the project's
model at low effort when supported.
Summarization reuses the account and model resolved for the foreground request,
with low effort when supported, fast mode off, no tools, bounded UTF-8 source
chunks, a two-minute deadline per summary request (a large prefix is many
sequential parts, so the deadline never covers the whole summary) and an automatic
retry cooldown of 30 seconds. Real failures also defer background retries, doubling
up to 30 minutes, but a hard context limit bypasses that extra deferral. Manual
`/compact` bypasses both. A stale or non-reducing summary is not a failure.
A finished summary that was not published (declined or failed) is kept: the next
summary reuses it while its exact prefix, input/context epoch and checkpoint are
unchanged, and summarizes only the messages that became older since. A
Claude session does not require an OpenAI login. Manual `/compact` can retry
immediately; automatic turns do not bypass the cooldown. No live provider
capability is implied by local tests.

Generated memory is validated after JSON parsing, against its compact stored
representation: at most 32 summary items, 16 pending items, 1000 characters per
item and 4096 conservatively estimated tokens. The prompt's 8000-character target
encourages brevity; it is not a second hard budget. A complete summary above that
target is accepted unchanged when it fits the token budget. Budget rejections
report both estimated tokens and serialized character count.
Formatting and JSON escape spellings do not inflate the stored budget; raw
responses still have a separate decoding limit. An oversized, malformed or
truncated summary gets one repair request for the same source part and previous
memory, using the same account/model with no tools. The repair is separately
metered as `rolling-summary-repair` and gets its own request deadline. The source
and system-message prefix stay identical; the repair instruction follows the source
to enable prefix-cache reuse. A part is sized to leave 8192 tokens for the written summary, but the request's
reply cap is all the room the window has left (`replyCap`): providers count
thinking against that cap, so a fixed small cap cuts a thinking summary off.
Accepted memory still has the 4096-token limit, checked locally. A small model
that cannot produce a valid summary of a part after its repair hands that part
to the conversation's model.
The generation allowance covers syntax and possible reasoning without relaxing
stored-memory validation. The source
and memory are never cut locally to satisfy validation. Provider/authentication
failures and refusals do not enter this repair path. If repair fails, the job
backs off; when the foreground cannot fit, its error retains the actual
compaction failure reason and originals remain unchanged.

The foreground continues while summaries run unless the context limit requires
waiting. Publication reloads the latest transcript under project/turn ownership,
checks an exact source prefix, context/cancellation epoch and previous checkpoint,
and conditionally appends against the locked head. All newer arrivals survive
verbatim. Tasks and preferences are read as saved at publication. Idle
maintenance only publishes work already requested; refresh never starts or
publishes inference. Page disposal, cancellation, clear or another checkpoint
invalidates stale work. The orchestrator daemon keeps the worker between turns;
the compiled one-shot probe joins it while owning the turn.

SQLite is a rebuildable private original-entry/task index, not a replacement for
JSONL or tasks.json: one global `~/.orca/memory.sqlite` (WAL, mode `0600`)
shared by all projects, with `project` and `agent` columns on every row, holding
only orchestrator transcripts and task records. Old per-project `memory.sqlite`
files are migrated by a background backfill and deleted only after the rebuilt
rows verify identical. Rows are written only at compaction and `/clear-context`;
searches only read, so messages since the last compaction are not searchable
(they are still in context). Search/read results are bounded historical text and
restricted to this project, the orchestrator and the current `/clear-context` scope; clear
does not delete bytes or receipts. See the
[reference rolling-memory section](REFERENCE.md#orchestrator-rolling-memory) for tool
arguments. Reasoning and image bytes/URLs are excluded from searchable text and
summary source. Scoped image references survive in raw archive records **and as
real image blocks alongside checkpoints**, not merely textual image descriptions.
Image IDs stay searchable without granting new forwarding permission.

A reduction may commit even when newer arrivals or retained images still exceed
the input budget. The normal request guard then fails explicitly rather than
sending an oversized or text-only request. A failed/stale checkpoint leaves
original context intact. No image-count reduction, automatic image eviction or
unbounded context is promised; see [IMAGE_ATTACHMENTS.md](IMAGE_ATTACHMENTS.md).

## Clear the chat display

The visual-only `/clear` command was removed with the command trim; only `/clear-context` remains. What it did: Model context, saved transcripts, cache, tasks, pending input, agents and other attached TUIs are unchanged. Refreshes and resizing keep earlier entries hidden; new replies still appear. Closing and reopening that conversation restores its saved history. In an agent view, only that view is cleared.

## Clear model context and cache

**What it does now:** `/clear-context` resets the project to how it was when it was
created. Confirming deletes everything under it through the same cascade as deleting
the project (see [the ownership tree](WORKSPACE_CLEANUP.md#the-ownership-tree)): its
history, tasks, questions, images, agents and worktrees, and nothing is kept on disk.
A project with the same id is then created in the same folder and gets its display
name, model/account/effort settings and pin back, and its page reopens in the same
tab with your draft. The question names what will be removed ("3 tasks, 2 agents, 1
worktree, 1 with uncommitted files that will be lost"). Local branches and their
commits stay, as do saved facts and the folder itself. It is refused, with nothing
removed, while an agent is live or cannot be checked, a command may still be
running, input is queued or the conversation is mid-turn.

The confirmation rules below are unchanged. The paragraphs after them describe the
earlier behaviour (a context boundary that kept the saved transcript); boundaries
already in a transcript are still read that way, but the command no longer writes one.

`/clear-context` takes no arguments and opens a **local, Cancel-default** confirmation
in the existing bottom menu area. Enter alone cancels. Select **Clear context**
with an arrow, then Enter to confirm. Escape cancels the confirmation. Ctrl+C
cancels it and stops the conversation and its subagents; drafts and saved history
remain intact. Typing, pastes and question shortcuts cannot
leak through the modal. Switching/closing pages, opening another menu, or resizing
invalidates it; even a tiny/hidden modal still owns its keys. `/clear-context` is deliberately
excluded from input recall. In a worker/reviewer view it refuses: Esc first.
With no project open it explains rather than creating one.

This clears the active orchestrator's model context, conversation display, rendered
row cache and rebuildable project `cache/`. Refresh, reopening, other attached
clients and exit replay show only conversation entries after the latest clear.
Saved transcripts, persistent memory, project identity, files/worktrees, model/settings,
accounts, questions/task records, worker/reviewer sessions and inboxes are retained. Normal
system instructions and tool definitions are still supplied on the next request.
Clearing does not call a provider, schedule a turn/compaction, retry a failed turn,
restart a session, or resume a cancelled orchestrator.

Both opening the confirmation and confirming require an idle orchestrator and
empty input queues: no running/requested compaction, raw durable orchestrator inbox
(including paused/cancelled entries), local submissions still being persisted,
sign-in-held text, queued previews, or in-flight local question answers. Pending
messages are never drained or discarded to make clearing possible. Inbox inspection
errors fail closed. A stale confirmation cannot change a different or
removed/recreated project: both Page ownership and captured directory identity are
checked, and publication uses the shared project-state lock.

The transcript appends an explicit `context-boundary` record with its parent still
pointing to the previous head. This is neither an empty summary nor a new root.
After reopen, `chain()` and `branch()` start **after** the latest boundary;
`history()` still walks through it to all original entries; the TUI filters at the
latest boundary before rendering. The marker itself is
not model content or a visible chat message. Later worker compaction only pins the first
original task **after** that boundary, including across repeated compactions;
checkpoint retrieval warnings explicitly exclude earlier epochs. Clearing is not
secure deletion: old context remains readable in saved history/files, and agents
may independently send reports referring to earlier work.

The same append protocol below protects the boundary. Pre-publication
failure or cancellation leaves the prior bytes/head/context usable. Rebuildable
cache may already have been evicted; a cache cleanup failure prevents the boundary
from being committed. After the commit point,
the clear is committed even if a late cancellation arrives; directory durability
failure is a warning, not a rollback. The session blocks overlapping turns and
compaction while publishing. Local `say()` during publication cancels a not-yet-
committed clear without losing the new input. Orchestrator inbox `put()` and clear
share the project lock across processes: an external send ordered after the clear
is retained as new input, not deleted. Local queued writes and leftover inbox temp
files conservatively refuse clearing. These guarantees cover managed project and
inbox operations. Clear and deletion also acquire the shared orchestrator turn
lock, refusing while another updated session owns a turn. Arbitrary filesystem
edits and older binaries that do not honor these locks remain unsupported (see
[SESSION_REFRESH.md](SESSION_REFRESH.md)).

## Policy and configuration

```toml
compact = true
contextLimitFallback = 128000
```

The fallback is a configurable **operational budget, not a claimed model limit**.
`model-context.ts` holds a verified table of standard windows for Codex (catalog
`context_window`, pinned source URL) and Claude (documented default windows); dated
Claude snapshot IDs use their base model's entry. Opt-in long context (Codex
`max_context_window`, Claude `[1m]` variants) is not assumed.

The provider catalogs fetched for `/model` fill gaps: Anthropic `max_input_tokens`
and Codex `context_window` (null, absent, 0, negative or non-finite values are
ignored). Precedence: explicit `contextLimit` > model window > `contextLimitFallback`
> 128000. The model window is the table entry, the catalog value, or the smaller of
the two when both exist, so a catalog never raises a model above its standard window
(Opus/Sonnet 4.6 stay 200k even if the catalog reports 1M). Table and catalog limits
are not estimates (no trailing `?` in the header); only the fallback is. The catalog
cache is in memory per process: each provider's catalog is fetched once in the
background when a turn first resolves that provider (retried on a later turn after a
failure) and is never awaited, so the first turn and header use the table or fallback. Embedders may supply verified
`AgentDeps.compaction.contextLimit` and `maxOutputTokens`. Effort/fast groups do not
establish context or output windows. No undocumented model limits are invented.

The project model/provider/credentials/settings are resolved **once per safe
boundary, before budgeting**. The snapshot (including effort and fast tier) is
used for worker/reviewer summary and following normal request. The orchestrator
uses its separate rolling summary model described above. Config changes during a
summary take effect at the next boundary, not between those two requests.
Credential errors abort; there is no fallback to stale credentials or provider.

Estimation is JSON UTF-8 bytes / 3 plus framing, system prompt, tool schemas and
1024 tokens for provider framing. This is conservative for typical prose/code,
not a tokenizer or guaranteed upper bound for Unicode, images or opaque reasoning.
Available Anthropic input usage (including cache read and creation tokens)
calibrates estimates upward with estimated subsequent growth; other providers
currently use estimates. Measurements are invalidated after compaction and ignored
across model changes.

Which model writes a summary depends on who waits for it:

| Summary | Trigger | Model | Effort |
| --- | --- | --- | --- |
| Orchestrator background memory | 25% of the window | the account's small model (Haiku, Luna) | highest up to xhigh |
| Foreground compaction (workers, reviewers) | 90% of the window | the agent's own model | lowest |

Background memory blocks nobody, so it can think longer on a cheaper model; if
the account refuses the small model, the part is retried on the conversation's
model at low effort. `smallSummaries = false` in config.toml keeps it there
always. Foreground compaction blocks the agent and its summary is all the agent
keeps, so it stays on the agent's model and asks for the least thinking. When a
model's effort levels are unknown, the agent's own setting is sent unchanged.

The foreground trigger (workers, reviewers, and the orchestrator's own safety
net) is **input >= 90% of the model's window**, the share Codex uses, on every
model. The reply's full reserve is not held back from the input: a request's
reply cap (`replyCap`) is the configured cap or, when the window is nearly
full, the room that is left. A request is sent only while a minimal reply
(8,192 tokens) and a margin for token-estimate error (3% of the window, at most
13,000 tokens) still fit; that bound only bites below 90% on windows far
smaller than any real model's. The orchestrator keeps its separate rolling policy described above.
With auto enabled, the default output cap /
accounting reserve is min(64000, 20% of window). The embedder's `outputReserve`
overrides that cap. It is normalized once per boundary: positive finite integer,
capped at the harness's 64000, context-1, and any supplied verified output ceiling.
Invalid overrides fall back to the default. With `compact=false`, the old 64000
normal output cap is preserved unless explicitly overridden or capped by known
context/output metadata. Disabling auto does not disable safety budget checks.
Worker/reviewer summary requests are sized to leave min(4096, normalized output cap) for the summary, ask for at most 600 words
and cap the reply at the room the window has left (thinking counts against the cap);
returned summaries over
4096 estimated tokens are rejected in addition to checking provider completion.

For workers/reviewers, before summary inference, both complete original task + retained tail + fixed
system/tools and the actual sanitized summary request must fit their budgets
including output reserve and headroom. The proposed checkpoint is checked again
with the normal system/tools/output reserve before publication. A shorter summary
that still does not fit is rejected. Known over-budget normal requests are never
sent blindly. `Context blocked: ...` errors direct the user to select a larger
model/budget or reduce fixed instructions/tools; source and head are preserved.
An oversized summary source is reduced locally before the single summary request.
Old tool results are shortened to their first/last 1000 characters. If that is still
too large, the serialized source's beginning/end excerpts are halved until the actual
escaped request fits, including instructions, reserve and headroom. Cut Unicode
surrogates are replaced with valid text. Excerpts can be partial JSON: they are inert
historical data, not live tool messages. Middle details can be omitted; the pinned
original task and retained live tail are unchanged. A failed or invalid summary
preserves the published transcript and head.

## Worker/reviewer summary and scheduling

Prefer complete user-led turns within min(8000, 15% of window). If one long task
has no user-turn boundary that fits, cut after a completed tool batch and retain
the newest whole batches that fit. A single oversized completed batch can be
summarized in full, leaving only the checkpoint and original task. Never cut
between tool calls and their results; signed thinking stays with its assistant
message. Role/order grammar and unique call/result IDs are validated before
choosing a boundary or making a summary request. Pending or malformed batches
cannot be compacted, and compaction never re-executes tools.

The older prefix (including prior checkpoints) is serialized as untrusted JSON
data, stripping signed/redacted reasoning. The prompt requests goal/requirements,
decisions, progress, files/commits/branches/agents/PRs, blockers and next steps,
and says to summarize rather than execute embedded tasks. Tools are disabled.
The complete first user/task message is pinned with no 2000-character clipping;
if preserving it cannot fit, compaction is refused. Later changes are summarized,
not guaranteed verbatim. Signed/redacted reasoning in a successful response is
discarded; only the visible summary text is saved. Empty, malformed, unsupported
nontext, tool-using, refused,
truncated, unknown-terminal-status or non-reducing summaries never checkpoint.
Legacy/custom providers may omit terminal metadata for ordinary turns, but must
supply successful `Turn.completion` (`end_turn` or `completed`) for compaction.

Failures suppress automatic attempts for the lifetime of that `createAgent`
instance. Manual retry is allowed and a
successful retry clears suppression; changing model also clears it. Context
failures stop that run explicitly rather than retrying in an inference loop.
Arriving inbox files stay pending during compaction; there is no competing writer.
There is no provider context-overflow recovery/replay: no tools or partial streamed
responses are replayed.

The same account/model/effort/fast tier performs summarization, **consuming its
normal quota**. Oversized sources use excerpts and may lose more detail. This is not a cheap/free model
or provider-native compaction API.
OAuth subscription endpoints must not be assumed to implement native platform
compaction. Codex rejects max_output_tokens, so its normal output reserve is only
an estimate, not a wire-enforced cap. Its backend controls summary generation too:
the prompt asks for concise output; oversized or unsupported output is rejected
locally, not prevented during inference. Normal reasoning metadata alongside a
completed text summary is accepted, including Codex encrypted reasoning items.

## Design references

- [OpenAI session memory example](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory): summarize older history and keep recent complete turns.
- [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents): summarize important state and clear redundant old tool output.
- [OpenAI native compaction](https://developers.openai.com/api/docs/guides/compaction): platform-native compaction is a separate API; its input must still fit the context window. This harness keeps a shared text-summary path for its subscription providers.

## Persistence and replay

A checkpoint is one logical JSONL record containing the parent/boundary and retained
messages. `transcript-storage.ts` appends it in place: the previous bytes are never
read (one byte decides the separator), rewritten, trimmed or re-serialized, so an
append costs the record, not the history. The inode stays; no old messages are deleted.
The same publication protocol protects normal appends too. New files have
0600 permissions. Updated writers serialize reload/parent selection/publication
with a per-transcript directory lock, and orchestrators additionally own a
cross-process lock for the whole model/tool turn. Reloads use the latest committed
disk head; old binaries and arbitrary external writers do not participate in this
protocol. Inbox receipts survive compaction and context clear, so cleanup residue
cannot replay previously consumed prompts. See [SESSION_REFRESH.md](SESSION_REFRESH.md).

1. Open the file for append (created 0600), take its length, and read its last byte:
   a damaged final line without a newline gets a separator first.
2. Loop until the separator, record and newline are written (including short writes),
   then fsync. A write or sync failure, a cancellation, or a refusing `authorize`
   truncates the file back to its prior length: the published bytes/head are unchanged.
   Legacy orphan `.pending` files are ignored.
3. **The commit point is the signal and `authorize` passing after that fsync**; nothing
   is awaited between them and the synchronous update of the in-memory head. If the
   rollback truncation itself fails, the disk decides: a complete record line is
   reported committed with a warning (every reader sees it), an incomplete one is a
   torn tail that readers skip and the next append separates. A process killed
   between write and fsync can leave either; reopen reads whatever is complete.
   A rollback that is followed by power loss before its own sync may resurface the
   withdrawn record.
4. A close failure after the commit, and a failed fsync of the containing directory
   (done only when the file was new or empty), are warnings, **not an append
   failure**: the visible record/head remain committed. Initial ancestor directory
   creation is not recursively fsynced. No guarantee is claimed against arbitrary
   storage corruption or filesystem behavior that violates append/fsync semantics.
   Readers that do not take the transcript lock can observe a record while it is
   being written; an incomplete line never parses.

Thus “failed summary leaves bytes unchanged” describes inference/validation and
pre-publication failure, not an arbitrary I/O failure after the commit point. UI
status errors cannot turn an already committed checkpoint into a reported failure.
Tests inject short writes, partial-write exceptions, sync/close/truncate failures and
post-commit directory failures, then append again and reopen.

`Transcript.chain()`/`branch()` follow context checkpoints. `history()` traverses
original entries through checkpoints and excludes synthetic checkpoint tails,
showing each original message exactly once. `Orchestrator.entries()` exposes full
UI replay, including the complete scrollable history and exit transcript. Invalid/truncated legacy JSON records
are ignored without deleting their bytes, and future appends remain recoverable.

## Image-bearing context

See [IMAGE_ATTACHMENTS.md](IMAGE_ATTACHMENTS.md). Images have a separate operational
token allowance (6,000 each), never a base64-as-prose estimate. Summaries describe
only text and IDs. Older pixels leave active context; original images and their
transcript records stay on disk. Recent image messages remain verbatim. Use
`read` with a previously received `attachment_id` to inspect an archived original.
The next `/compact` also repairs old checkpoints that reattached all historical
images. Oversized recent input still fails explicitly; compaction does not erase
the newest turn. Request copies obey the provider's many-image dimension limits. `/clear-context` also refuses unconsumed image-submission journals; a successful
clear keeps original bytes, journals, history and consumption receipts on disk.

## Switching accounts or context windows

A model, account, or context-window change cancels the previous background summary
and clears its retry backoff. The next job uses the resolved selected account/model;
a named profile does not require a `default` login. Source parts are split until
each request fits the selected window, so a transcript larger than the new model
can be summarized before its first foreground request. Original history and the
recent verbatim tail are preserved. Fixed instructions or a retained tail that
cannot fit still produce an explicit context error instead of dropping content.

Provider prefixes and reference updates: the role prompt/tools remain separate
from conversation summaries. Current reference context is represented by durable,
append-only messages, updating only changed named sections. A checkpoint may
retain those messages; if it summarizes them away, the loop appends the missing
current sections before the next request. These messages count toward the same
existing budgets. This changes the representation of knowledge, not the summary
algorithm or compaction thresholds. Internal reference updates stay hidden from
chat restoration and never count as fresh human input or authorization.
