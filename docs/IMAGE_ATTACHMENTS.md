# Clipboard images and agent vision

## User controls

In the **project chat composer**, press **Ctrl+V** to read one clipboard image
on demand. There is no clipboard polling or startup read. The draft shows
`[Image 1]`, `[Image 2]`, etc. **Ctrl+Y removes the last image**; repeat to remove
more. Escape clears the chat draft and its images. Enter submits the text and
images together, including an image-only draft. Labels contain no binary/base64.
Images are page-owned: switching projects keeps each open page's draft separate.
Unsubmitted drafts are not restored after closing their page or exiting.

Normal terminal text paste (including bracketed/multiline paste), cursor editing
and Option-Backspace are unchanged. Ctrl+V with text-only/empty clipboard reports
that there is no image and leaves the draft unchanged; it **does not also paste
text**, avoiding duplicate terminal paste. Use the terminal's normal text-paste
shortcut. A terminal or multiplexer that intercepts Ctrl+V must deliver the literal
control key for this feature to work. `/keys` (or draft-safe Ctrl+G) shows what
arrives; Parallels does not change terminal settings or key bindings for you.

Menus, projects, help, task/question panels and agent views keep ownership of
input. Ctrl+V does not attach an image to a question answer. Pending asynchronous
reads are invalidated by send/clear/cancel, removal/history navigation, refresh,
page changes/close/delete, and modal changes. Repeated Ctrl+V while reading reports
that the read is in progress. Ordinary editing of the same chat draft is allowed.

Slash commands with attached images are refused **without changing the draft**.
Remove images first; no command silently consumes or sends them. Draft image
history recall is refused to avoid associating pixels with a different prompt.
Input recall saves only the text, not attachments; committed conversation history
and queue previews show image labels.

## Local clipboard mechanisms and limits

- **macOS:** embedded JavaScript for Automation via system `/usr/bin/osascript`,
  using AppKit/Foundation pasteboard APIs directly. No desktop app/UI automation,
  helper installation, `pngpaste`, Swift compiler, native addon, or Bun runtime is
  needed by the compiled executable. Native PNG is read as-is; TIFF/JPEG are
  converted by `NSBitmapImageRep` to PNG. A pasteboard change during the read fails
  instead of attaching an inconsistent snapshot. Clipboard files/URLs are not
  followed. Copied animated/unsupported formats are rejected.
- **Linux:** use an **already available** `wl-paste` with `WAYLAND_DISPLAY`, or
  `xclip` with `DISPLAY`. Targets are checked for `image/png` before reading bytes.
  No dependency is installed and no automatic fallback changes the clipboard.
- SSH/headless/unavailable mechanisms produce actionable errors. Clipboard
  subprocesses have a 5-second timeout and bounded stdout/stderr. These checks
  cannot prove that an arbitrary remote desktop's clipboard is local to a user.

Up to **4 images per prompt**, **4 MiB encoded PNG per image**, maximum dimensions
**4096 × 4096**, maximum decoded scanlines **64 MiB**. PNG signature, chunk bounds,
CRC/order, color depth, dimensions, bounded zlib inflation and scanline filters
are validated; suffixes and MIME claims are insufficient. Interlaced/animated
PNGs are deliberately unsupported; recopy/export a non-interlaced still PNG.
No silent downscaling. macOS source TIFF/JPEG must also fit 4 MiB before conversion.
This is bounded validation, not a general-purpose image decoder or sandbox for
malicious local software.

## Queue durability, refresh and failure recovery

Image bytes are saved atomically **before** references are published. A reference
contains a random image UUID, SHA-256, and a scope derived from the immutable
project directory identity. Only that project's validated local image can be
resolved; arbitrary paths/URLs, cross-project references, changed bytes, and
symlinked image files/directories are refused. Saved inbox/transcript records
contain references and labels, **never data URIs or raw image bytes**.

Each submitted image prompt has a separate immutable `inputId` and an immutable
`image-inputs/<inputId>.json` journal under the project. The journal includes the
original text, ordered references, submission/cancellation epoch and publication
time. Login-held prompts are journaled, too. Journal retries compare canonical
prompt metadata and preserve the first publication time; independent inputs are
not equated by identical text. Recovery order follows publication time (same-time
cross-process order is unspecified, as for the inbox).

PR #70's committed input/delivery receipts remain the only consumption evidence.
Refresh/reopen restores image labels and unconfirmed prompt previews, not delivery
inferred from absent files or matching text. The inbox consumer commits **the
prompt, image references and receipt together** before removing inbox files or
acknowledging UI previews. Cross-process turn/clear ownership is unchanged.

**`/retry-images` explicitly republishes unconfirmed image prompts with their
original IDs**, never a newly generated retry ID. Reopen/refresh never
*republishes* them automatically. A previously published ordinary durable inbox
entry can still be consumed by normal scheduler polling, exactly like text input.
Consumption receipts suppress duplicate retries even after interrupted cleanup
or a second window's retry. Cancellation epochs are preserved: retrying an older
paused input does not itself bypass cancellation; a new user message resumes it.

If disk publication fails, the current window keeps the prompt/references for
explicit retry and reports the error. A failure **before the journal can be
written** cannot guarantee restart recovery; do not close that window before
retrying successfully. Missing/corrupt image data fails closed. Login failure
keeps image prompts for explicit retry rather than dropping them. A confirmed
`/clear` refuses while any unconsumed durable image journal exists, including one
held by a different window.

A receipt means **committed context, not provider success**. Model rejection,
serialization errors or provider failure leave the image-bearing transcript
intact, never silently retry text-only or change providers. Consumed input is not
replayed by `/retry-images`; explicitly choose a supported model if needed, then
send a new message to resume the saved context. Model changes alone do not resume
failed turns or restart workers.

Validated image bytes and submission journals remain under the project until
**project deletion**, including removed/unsubmitted attachments and after
`/clear`. This conservative retention avoids releasing bytes still needed by
queues, histories or workers. `/clear` resets only the orchestrator's context;
old receipts/history remain, old prompts do not reappear as unconsumed, and old
images are not forwarded implicitly. This is not secure deletion. There is no history image picker: reattach a
pre-clear image from the clipboard to include it in a new context. There is no
automatic image garbage collection or disk quota yet. Use project deletion only
when its normal safety checks permit it and the data is no longer needed.

## Provider and worker delivery

Immediately before a normal model request, scoped references are loaded, hashed
and validated into actual **Anthropic base64 PNG image blocks**. Claude receives
these blocks, interleaved with the prompt and attachment-ID labels. Codex/OpenAI
Responses receives equivalent ordered **`input_image` data URLs**, alongside
`input_text` in the same user item. No filename-only substitute is sent. Unresolved
references, unsupported/nested tool-result image inputs and assistant image inputs
fail explicitly rather than disappearing in a text serializer.

`requireVision` in `src/images.ts` contains explicit model-ID admission lists,
**independent of effort/fast settings**. Unknown IDs fail closed with instructions
to select a supported vision model. Known local defaults (`claude-sonnet-5-5`,
`gpt-5.5`) and the enumerated Claude 3+/4+/5 and GPT-4o/4.1/5/6 IDs are admitted;
this operational list is **not live service capability/entitlement verification**.
The full exact list is the source of truth. Models outside it may support vision
but need a reviewed admission change. A provider rejection is surfaced unchanged;
there is no automatic provider/model fallback.

The Codex admission update verified on **2026-10-23** includes `gpt-6-astra`,
`gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, and `codex-auto-review`. Each explicitly advertises `image` in
`input_modalities` in the same
[Codex catalog snapshot](https://github.com/openai/codex/blob/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/models-manager/models.json)
used for request settings. The
[GPT-6 Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra)
also documents image input. Provider model discovery alone does not grant image
admission, and reasoning/fast support is not used to infer vision support. Future
model additions need an explicit modality check as well as settings validation.
Unknown IDs and unverified aliases/date variants remain refused.

Agents receive a real image block plus `[Image N; attachment_id=<UUID>]`.
Delegation must **explicitly** pass relevant IDs:

```json
{"branch":"visual-task","taskId":"<registered task UUID>","prompt":"Implement this screen","attachments":["<attachment_id>"]}
```

The `message` tool accepts the same optional `attachments` list for an agent
recipient. Omitted means no images; sending to `user` with images is refused.
Up to four distinct IDs must occur as real user image blocks in the sender's
current transcript **context epoch**, not just in prose or a guessed UUID.
Forwarded worker/reviewer inbox/initial context uses the same actual pixel
materialization and both provider serializers. Worktrees/tasks/branch semantics
and tool call/result pairing are unchanged. No implicit sharing of all past images.

## Context budgeting and integration contract

Each image contributes a **6,000-token operational allowance**, rather than
counting base64 as prose. This is not a provider tokenizer or guaranteed maximum.
Materialized context has a **16 MiB encoded-PNG-byte total cap**; base64 transport
is larger. Multiple prompts and repeated forwarding of the same image count
separately. Large accumulated histories can therefore block another request.

Both **orchestrator rolling memory** (merged PR #74) and worker/reviewer
checkpoints send summarizers textual IDs with explicit warnings that they did
not inspect pixels. `image-history.ts` supplies text-only historical markers for
summaries and search; it never serializes image bytes/URLs as model prose. Actual
image-reference blocks and bounded historical prompt excerpts are retained
alongside each checkpoint/recent tail. Repeated checkpoints retain each image
occurrence exactly once; new messages arriving during background work remain
verbatim. The following normal request still receives inspectable pixels.

The rolling `gpt-6-luna` summarizer remains text-only and uses the account/scheduling
policy of #74; there is no new vision/provider fallback. Its summary can reduce
prose while retained images still exceed the foreground budget. In that case a
checkpoint may commit the reduction, but the foreground request is explicitly
blocked. Worker checkpoints instead refuse an over-budget proposal. Neither path
silently drops images. Use an explicit `/clear` for a new task when accumulation
blocks context; original transcripts/images remain on disk.

The global SQLite `~/.parallels/memory.sqlite` (rows keyed by project and agent) keeps the **original scoped references** losslessly in
`entries.raw`, and indexes searchable `attachment_id` markers plus prompt text in
`entries.body`. Image bytes stay in the validated project image store. The
orchestrator can use `task search_history` (including an attachment UUID query)
and paged `read_history` to recover prompt/ID associations **within the current
clear scope**. Search/read results are historical **text**, not new images or new
permissions. Pixels remain directly inspectable in retained context, so no extra
image-read tool or implicit cross-task image sharing is needed. Explicit
spawn/message forwarding still requires a real original image in the sender's
current context epoch, not merely a retrieved or guessed UUID. After `/clear`,
old history IDs cannot retrieve/forward old images; reattach from the clipboard.
The orchestrator-only `history` tool (earlier sessions and other projects) returns the
same text markers only: never pixels, and no forwarding permission. Image IDs stay
project-scoped.

`materializeImages` and `requireVision` remain at the provider boundary. Keep
image budgeting, original prompt association, exact receipts, shared cancellation
and conditional checkpoint publication intact when changing memory semantics.
`forwardImages` authorizes against `afterContextBoundary(transcript.history())`;
checkpoint tails must not replace original history for that check. Combined
regressions in `rolling-images.test.ts` cover repeated compaction, search/reload,
both provider serializers, explicit worker pixels, clear/cancel, newer arrivals,
failed publication, unsupported models, missing bytes and image-budget refusal.

## Validation and reviewer constraints

Tests use per-test temporary project storage, injected clipboard adapters,
fixture PNGs, fake providers and local serializers. Native JXA tests replace the
pasteboard expression with an in-memory fixture; **no live clipboard is read or
changed**. The relocated compiled probe embeds the same clipboard script and
storage/provider pipeline and runs with no Bun on PATH. Existing compiled CLI,
PTY, installer and updater tests operate only in temporary owned fixtures.
These tests validate request structure/bytes, not a live provider's visual
reasoning or service acceptance.

This feature started on merged PR #70 (`112f1de09c03d42734a9e75ba7dca94dbd1f41e8`)
and integrates current main through merged PR #74
(`aa9064ed4a88ea10ae7927ce6bb2514569e668fe`, including #72/#73). The original
unmerged #71 branch is not used or modified.
Publication belongs to the independently invoked reviewer. Before publication,
validate the current clean branch head locally with `bun test`, `bun run check`,
`bun run build`, and `git diff --check`; no hosted-check absence is a substitute.
**No hosted CI/workflow runs, live clipboard/provider tests, installed-app changes,
live-session restarts, or unrelated worktree changes are authorized by this task.**
Do not run `install:local`/`pull` against the real installation. The protected
local gallery and the merged/retired `feat-session-refresh` worktree are out of
scope. The worker only commits locally; publication is reviewer-owned.

Pre-integration worker validation (commit `fef8182`): `bun test` **1,034 pass, 0 fail**,
8 snapshots and 18,219 assertions across 76 files (57.38 s); `bun run check`,
`bun run build` (552 bundled modules), and `git diff --check` passed. Existing
locked dependencies were provisioned offline with `bun install --offline
--frozen-lockfile`; no manifest/lockfile changes or new dependencies. These are
local results only; the reviewer must revalidate its actual publication head.

Final integrated worker validation against `origin/main` at `aa9064e`:
focused image/rolling/compaction suites **101 pass, 0 fail**, 632 assertions in
6 files (1.288 s); full `bun test` **1,083 pass, 0 fail**, 8 snapshots and
18,635 assertions across 79 files (59.12 s). `bun run check`, `bun run build`
(556 bundled modules), and staged/unstaged `git diff --check` passed. The added
combined suite has 10 isolated regressions; no new dependencies, hosted checks,
live clipboard/provider calls or installation updates were used for integration.
