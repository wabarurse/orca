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
arrives; orca does not change terminal settings or key bindings for you.

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
references, invalid image bytes and assistant image inputs fail explicitly rather
than disappearing in a text serializer; images nested in a tool result (see
"Images read by a tool") are serialized for both providers.

Orca attempts image requests with every selectable model, including unknown IDs
and aliases, without a model-name allowlist. This does **not** guarantee provider
image support or account entitlement. Image byte, format, size and security
validation still applies, independently of model effort/fast settings and account
authentication. Provider rejection is surfaced through the existing error path;
attachments remain preserved, with no silent dropping, automatic model/provider
switching or text-only fallback. Model discovery and request-settings catalogs
are not image-admission gates.

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

## Images read by a tool

`read` on an image file returns the image itself, so an agent can look at a
screenshot it just took. The format comes from the file's magic bytes (PNG,
JPEG, GIF, WebP), never its name. The file must stay within the workspace and
evidence directories, at most **4 MiB** and **4096 × 4096**; PNG gets the full
structural validation, JPEG/GIF/WebP signature and header dimensions. Larger
images fail with a downscale command to run first (`sips -Z 1568 in.png --out
in-small.png` on macOS, `magick … -resize 1568x1568` elsewhere).

The bytes are saved to the project image store exactly as clipboard images are
(`images/<id>.<ext>`), and the tool result is a text block (path, revision,
type, width, height, bytes, `attachment_id`) followed by a scoped image block,
both inside the `tool_result`. Transcripts never hold the bytes. Before a
request they are materialized like prompt images: Claude receives the base64
image block nested in its `tool_result`, which the Messages API admits; Codex /
OpenAI Responses receives a `function_call_output` whose `output` is an
`input_text` + `input_image` (data URL) list, the form Codex's own image tool
uses. There is no model-name vision gate: a model or account that rejects image
input fails through the normal provider error path, without a text-only retry.
The attachment ID can be forwarded with `spawn`/`message` like a prompt image.

Prompt images always count against the 16 MiB request cap and are never
dropped. Tool-read images fill the remaining space newest first; an older one
that no longer fits is replaced, in that request only, by a note to read the
file again. Summaries and rolling memory do not retain tool-read images: their
marker says the file can be read again.

## Context budgeting and integration contract

Each image contributes a **6,000-token operational allowance**, rather than
counting base64 as prose. This is not a provider tokenizer or guaranteed maximum.
Materialized context has a **16 MiB encoded-image-byte total cap**; base64 transport
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

The global SQLite `~/.orca/memory.sqlite` (rows keyed by project and agent) keeps the **original scoped references** losslessly in
`entries.raw`, and indexes searchable `attachment_id` markers plus prompt text in
`entries.body`. Image bytes stay in the validated project image store. The
orchestrator can use `task search_history` (including an attachment UUID query)
and paged `read_history` to recover prompt/ID associations **within the current
clear scope**. Search/read results are historical **text**, not new images or new
permissions. Pixels remain directly inspectable in retained context, so no history
image-read tool or implicit cross-task image sharing is needed. Explicit
spawn/message forwarding still requires a real original image in the sender's
current context epoch, not merely a retrieved or guessed UUID. After `/clear`,
old history IDs cannot retrieve/forward old images; reattach from the clipboard.
The orchestrator-only `history` tool (earlier sessions and other projects) returns the
same text markers only: never pixels, and no forwarding permission. Image IDs stay
project-scoped.

`materializeImages` and provider image validation remain at the request boundary. Keep
image budgeting, original prompt association, exact receipts, shared cancellation
and conditional checkpoint publication intact when changing memory semantics.
`forwardImages` authorizes against `afterContextBoundary(transcript.history())`;
checkpoint tails must not replace original history for that check. Combined
regressions in `rolling-images.test.ts` cover repeated compaction, search/reload,
both provider serializers, explicit worker pixels, clear/cancel, newer arrivals,
failed publication, missing bytes and image-budget refusal.

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
