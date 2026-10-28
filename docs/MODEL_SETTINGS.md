# Project model, effort, and fast mode

`/model` selects this project's model from a picker of the models offered by
the project's selected account (one provider; `/accounts` switches provider).
There is no id argument. Live worker/reviewer **tmux windows**, not transcript filenames,
require confirmation; failed/unknown liveness refuses the change. A known
missing tmux session is empty and may switch immediately. No project means an
explanation, never an implicit new project or global-default write.

`/effort` opens the same arrow-key menu as `/model`: `default` plus the levels
the project's current model supports, with the effective choice marked. Enter
saves for exactly the model the menu was opened for (a model switched meanwhile
refuses the save); Esc cancels. `/effort <level|default>` saves an explicit
effort directly, or omits it for the backend's own default. `/fast` reports the
effective mode; `/fast on|off` changes it. Fast is a speed/tier request, **not**
low reasoning effort. It can increase usage or cost and requires provider/account
entitlement. No header controls are provided for these settings.

The menu's levels come from the provider catalog when it reports them: the
Codex `/models` entries list `supported_reasoning_levels`, and the Anthropic
models API reports `capabilities.effort` per level. Both are recorded by the
same once-per-process catalog fetch that supplies context windows
(`prefetchContextLimits`; the picker waits for it, turns never do), filtered to
the levels this harness implements, and consulted by `modelCapabilities`, so
validation of direct `/effort <level>` uses the same list. A model the catalog
does not list, or lists without levels, or a failed/unauthenticated fetch, keeps
the built-in table below.

That list is therefore time-varying within a process (the background prefetch
lands after the first request) and differs between processes (TUI, daemon, each
agent) until each has fetched. So only **saves** validate effort against the
current list. The request path never throws on a saved effort: `effectiveSettings`
(`effectiveSettingsReport`) omits an effort the current list lacks and reports it
as `dropped`, so the request uses the backend default and an agent mid-run keeps
working. The value stays on disk: it applies again wherever the list includes it
(for example in a process without catalog data), the `/effort` picker marks
`default` and prints a note, and the next `/effort` or `/fast` save merges onto
the effective settings, so the dead effort is not carried along. Providers'
own `validateSettings` call accepts every level the table or the catalog has
reported (`knownEfforts`), so a request resolved just before the catalog landed
is not refused locally; the service may still reject it. A saved **fast** mode
the model does not support remains an error as before.

## Persistence and next-request boundary

- The project `model` record in `memory.sqlite` overrides global `config.model`; absence preserves the
  existing global default, including `gpt-6-astra`. Other projects never change.
- The project `flow` record in `memory.sqlite` saves the project's review-round limit and
  dynamic-dispatch switch (`/review-rounds`, `/dynamic-dispatch`); absence or a
  missing key keeps `config.toml`'s `maxReviewRounds` / `dynamicDispatch`. Values
  are validated on read and save (integer 0–100, boolean, no other keys); a
  malformed record is refused, never repaired by a save. Agents read them when
  building their prompt (orchestrator: every turn; worker/reviewer: at start).
- The project `model-settings` record in `memory.sqlite` saves effort/fast **by exact model id**.
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
  `project-locks/<id>` directory lock outside the project. Ordering begins when
  `saveProjectModel` / `saveProjectSettings` / `saveProjectFlow` is invoked, not
  before an effort/fast command finishes its asynchronous model read. A settings save queued behind a
  model switch rejects its old-model target without updating either preference.
  Successive effort/fast patches merge under the lock and retain both fields.
  Managed project
  create/delete use the same lock. The directory's device/inode/birthtime is
  captured before waiting, checked inside the lock and before rename. A queued
  old-generation save refuses after managed delete/recreate, never resurrecting
  that project. Files use unique sibling temp files plus atomic rename.
- The lock records its owner (`owner.json`: pid, since, project). Holders stay
  brief: no network, git, gh or model call runs under it (dependency task actions
  hold their own `dependency-locks/<id>` across git/gh and take the project lock
  only for their ledger reads and writes), and reads (task list/get, history
  search) take no lock. A contender retries with backoff (10ms doubling to 250ms,
  jittered) for up to 30 seconds, then fails clearly, naming the owner. A lock
  whose recorded owner pid is verifiably dead is taken over; a live, unsignalable
  or unrecorded owner's never is. Remove such a lock only after confirming no orca
  process is using it. An agent's run tracking (the branch-readiness invalidation
  before a shell/edit tool call) that cannot be recorded refuses that one tool
  call and keeps the run going; it is recorded before the next call runs. Arbitrary external
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

`src/providers/catalog/capabilities.ts` deliberately supports a **subset**, by exact id,
when the catalog reports nothing for the model:

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
unchanged. The selected saved entry and incoming patch must be records containing
only `effort` (string) and `fast` (boolean); null, arrays, scalars, invalid value
types, and unexpected keys refuse before any merge/write, including reset
commands. Files remain byte-for-byte unchanged on refusal. `default`/`off` can
still reset well-shaped preferences that are no longer supported; they never
silently repair malformed stored data. `default` and `off` remain safe resets for any model. Endpoint
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
