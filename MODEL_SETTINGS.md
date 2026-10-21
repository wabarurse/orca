# Project model, effort, and fast mode

`/models [id]` selects this project's model. The picker and explicit id share a
single path. Live worker/reviewer **tmux windows**, not transcript filenames,
require confirmation; failed/unknown liveness refuses the change. A known
missing tmux session is empty and may switch immediately. No project means an
explanation, never an implicit new project or global-default write.

`/effort` reports the effective value and supported choices.
`/effort <level|default>` saves an explicit effort, or omits it for the backend's
own default. `/fast` reports the effective mode; `/fast on|off` changes it.
Fast is a speed/tier request, **not** low reasoning effort. It can increase usage
or cost and requires provider/account entitlement. No extra menus or header
controls are provided for these settings.

## Persistence and next-request boundary

- `projects/<id>/model` overrides global `config.model`; absence preserves the
  existing global default, including `gpt-6-astra`. Other projects never change.
- `projects/<id>/model-settings.json` saves effort/fast **by exact model id**.
  Switching models uses that model's saved preference, or backend-default effort
  and fast off. Switching back restores its preference. Values do not carry
  between providers/models, so a previously selected unsupported effort/tier
  cannot leak into another model's payload. Queries always describe the current
  model; save responses explicitly say project/model scope.
- Every agent resolves model, provider, and settings before **each request**,
  even during a tool loop. No tool, in-flight call, transcript or worktree is
  interrupted/reset. Settings never start a turn or a process.
- After a failed/stopped orchestrator turn, **send another message to resume**.
  Drained inbox messages remain in the transcript, but the failed task is not
  automatically replayed just because a model/setting changed. Explicit resume
  includes retained history and the new message. Exited workers/reviewers require
  an explicit restart; model/settings changes never restart them. New messages
  arriving independently may start a normal new orchestrator turn.
- Async model operations have generations: newer model commands, Escape, other
  menus, page switches (including away/back), close, and quit invalidate older
  catalog/liveness/confirmation results. Before commit, stale results do nothing.
  **Once confirmed and persistence starts, the commit belongs to the captured
  project even if selection changes or its page closes.**
- Model/settings saves use a per-project invocation-order queue and exclusive
  `project-locks/<id>` directory lock outside the project. Managed project
  create/delete use the same lock. The directory's device/inode/birthtime is
  captured before waiting, checked inside the lock and before rename. A queued
  old-generation save refuses after managed delete/recreate, never resurrecting
  that project. Files use unique sibling temp files plus atomic rename.
- A crashed process may leave a lock. Acquisition fails clearly after ~5 seconds,
  rather than stealing an uncertain lock; the error names it. Remove a stale lock
  only after confirming no parallels process is using it. Arbitrary external
  filesystem operations that ignore the lock are **not** a supported concurrency
  protocol; atomic rename alone does not protect against such mutations.

## Verified endpoint parameters and conservative support snapshot

Verification used installed `@anthropic-ai/sdk` **0.135.0**, `openai` **7.39.0**,
plus the following official sources (no live inference/paid request was made):

- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort):
  `output_config.effort` (no effort beta header required).
- [Claude fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode):
  `speed: "fast"`. Opus 5.5 needs no fast beta; Opus 5 and Opus 4.8 require
  `fast-mode-2026-02-01`. Existing OAuth betas are preserved when adding it.
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level)
  lists effort choices for subscription usage.
- [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode) explicitly
  documents subscription availability (Pro/Max/Team/Enterprise), usage credits,
  organization enablement, and the supported Opus models. Protocol support does
  **not** establish that an individual account has fast-mode access/credits.
- Codex source snapshot
  [`9b39316997fd8bcecdb2007722f52ef858f0dbd8`](https://github.com/openai/codex/tree/9b39316997fd8bcecdb2007722f52ef858f0dbd8):
  [`models-manager/models.json`](https://github.com/openai/codex/blob/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/models-manager/models.json)
  advertises model `supported_reasoning_levels` and Fast tier `priority`;
  [`core/src/client.rs`](https://github.com/openai/codex/blob/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/core/src/client.rs)
  constructs `reasoning.effort` and `service_tier`, while
  [`protocol/src/openai_models.rs`](https://github.com/openai/codex/blob/9b39316997fd8bcecdb2007722f52ef858f0dbd8/codex-rs/protocol/src/openai_models.rs)
  filters tiers against model support. This is Codex's subscription Responses
  path, **not** an assumed translation from generic platform API types.
  Our existing adapter calls `https://chatgpt.com/backend-api/codex/responses`;
  selected fast mode sends `service_tier: "priority"` independently of effort.

`src/model-capabilities.ts` deliberately supports a **subset**, by exact id:

| Models | Explicit effort | Fast |
| --- | --- | --- |
| Claude Fable 5.1/5; Opus 5.5/5/4.8/4.7; Sonnet 5.5/5; Haiku 5.5 | low, medium, high, xhigh, max | only Opus 5.5/5/4.8 |
| Claude Opus 4.6, Sonnet 4.6 | low, medium, high, max | no |
| gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, codex-auto-review | low, medium, high, xhigh, max | priority |
| gpt-5.5 | low, medium, high, xhigh | priority |
| Any other exact id (including unknown aliases/date variants) | default only | off only |

The Codex snapshot also advertises `ultra` on some models, with automatic task
delegation; installed SDK effort types do not support it and this harness does
not implement that mode. It is intentionally refused, as are unverified models
and tiers. This conservative table can require updates as providers change.
Unsupported explicit settings fail **before persistence**, leaving saved state
unchanged. `default` and `off` remain safe resets for any model. Endpoint
entitlement/model availability failures still surface clearly at request time;
there is no fallback to different credentials/provider/billing or silent retry.

## Transcript compatibility limitations

The canonical transcript remains Anthropic-shaped. The named `claudeMessages`
helper omits recognized Codex encrypted reasoning only in outbound Claude
requests, drops empty messages, and preserves the source history. Codex already
omits Claude signed/redacted thinking. Tests use real `fromResponses` output,
caller metadata, multiple/error tool-result pairs, mixed roundtrips and
reasoning-only messages. Native Claude signed/redacted thinking remains intact
across Claude models: tests prove preservation, **not live-service signature
acceptance**. Image/document and other provider-only block translations are not
added by this feature. Unsupported historic content can still cause a service
error and requires user-directed recovery; nothing silently discards/replays a
failed task.
