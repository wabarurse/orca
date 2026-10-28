# Adaptive agent runtime

Orca uses one agent loop across orchestrator, worker and reviewer roles. The model chooses tools from the user's current request and evidence. There is no classifier that assigns conversations to direct execution, iteration or publication loops. A one-off script can run directly or in a worker without registering a task, creating a reviewer, committing, opening a PR or starting CI.

Publication remains a separately authorized capability. Existing task, dependency, review, CI and merge safeguards still apply when publishing. This change does not auto-merge or install a running build.

## Delivered capabilities

| Area | Behavior | Main implementation |
| --- | --- | --- |
| Consolidation | Integrates the intent and source-attributed memory changes with the runtime work | Role prompts, memory archive and this document |
| Provider reliability | Preserves streamed Codex output when the completion envelope is empty; handles limit/refusal/error separately; bounds pauses and recovery without replaying delivered stream content | `src/providers/{openai,anthropic,account,bounded-request}.ts`, `src/core/agent-loop/loop/agent.ts` |
| Optional delegation | `spawn` only requires a brief. Task registration and explicit review are independent | `src/core/tools/spawn.ts` |
| Small coordinator context | Focused delegation, concise worker reports, selected knowledge and a 32k-token default compaction target | `src/core/prompt/orchestrator.ts`, orchestrator session |
| Fresh context | A new worker starts from its brief; `fresh: true` resets an idle worker's active context on its existing branch, retaining original history | Spawn and transcripts |
| Durable detail | Large reports require a concise summary; full evidence is saved outside the repository with a retrieval path | `src/core/tools/message.ts` |
| File tools | Bounded `read`, exclusive-create `write`, revision-checked replacement and exact `edit` | `src/core/tools/files.ts` |
| Background commands | Bash can yield a process handle while a separate supervisor owns execution and output | `src/core/data/processes/` |
| Runtime events | Readiness and terminal events have durable IDs/outboxes; cancellation, timeouts, output caps and lost-supervisor reconciliation are explicit | Processes and inbox observations |
| Iteration | User corrections remain separate from summaries; direct feedback resumes the same idle worker branch | Knowledge, `src/tui/commands/feedback.ts` |
| Usable results | Shared brief records paths, revision/evidence references and preview handles, distinguishing reports from timestamped readiness observations | `src/core/tools/context.ts` |
| Running-build visibility | `/runtime` shows loaded UI/daemon/agent builds and observed context; source files do not imply a running process loaded them | `src/config/build.ts`, runtime observations |
| Personalization | Inspect, save, update and forget user/project facts with source and confidence | `src/core/tools/remember.ts`, knowledge |
| Instructions and skills | Scoped AGENTS/CLAUDE discovery and a small skill catalog; full skill content loads on demand | `src/core/data/knowledge/instructions.ts`, skill tool |
| Worker feedback/status | Selected agent view sends input to that agent; reports delivery/resume and waiting activity | TUI app and feedback command |
| Ownership/execution | One live writer per branch, process ownership checks and optional OS write isolation | Spawn, tmux runner, `src/core/execution.ts` |
| Accounting | Model, summary, search, retry, tool and supervised-process observations are attributable to projects/agents when known | `src/providers/usage.ts`, `/usage` |
| Regression evaluation | Scripted end-to-end runtime cases cover delegation, feedback, files, process lifecycle, providers, memory and accounting | `evals/adaptive/` |

## Using the capabilities

These are model tool inputs, not new workflow modes:

```json
{"tool":"spawn","input":{"prompt":"Run the importer against the fixture and report the output","branch":"work-import"}}
{"tool":"bash","input":{"command":"bun run dev","background":true,"timeout_ms":0,"ready_url":"http://127.0.0.1:3000/"}}
{"tool":"process","input":{"action":"output","id":"<returned handle>","cursor":0}}
{"tool":"process","input":{"action":"input","id":"<returned handle>","text":"yes\n"}}
{"tool":"process","input":{"action":"stop","id":"<returned handle>"}}
{"tool":"spawn","input":{"prompt":"Fresh handoff: preserve the preview and fix only the title size","branch":"work-import","fresh":true}}
```

A worker can receive feedback through its selected TUI view or the coordinator's `message` tool. An idle worker resumes on its existing branch; a running worker receives an inbox message at the next safe boundary. Fresh context is explicit. Archived publication branches are not silently reused. Image feedback to an idle worker currently requires routing through the orchestrator; live workers accept attachments.

`read` returns a content revision and a numbered, bounded preview. Replacing with `write` or using `edit` requires the last observed `expected_revision`; creation refuses an existing path. Edits require one exact match. Files must be regular UTF-8 files of at most 2 MiB. Symlinks and `.git` files are refused; paths stay within the canonical workspace, with read-only access to evidence and discovered personal skills. Parent folders must already exist. Cooperative locks protect Orca writers; this is not an atomic compare-and-swap against hostile external filesystem writers.

## Process lifecycle and recovery

`background: true` returns immediately. `yield_ms` waits at most 30 seconds before yielding; `timeout_ms` controls lifetime separately. The default lifetime is ten minutes; zero permits a supervised long-lived service. Each process saves command, owner, run, project incarnation, output, state and events beneath `.runtime/projects/<id>/processes/<handle>/`. Command state and output can contain sensitive user data; usage accounting deliberately excludes their bodies.

The supervisor captures bounded output, accepts ordered stdin messages, probes optional localhost HTTP readiness, and stops its command group on cancellation, timeout or output overflow. Readiness means the URL answered successfully at a recorded time; it does not prove that the child owns that listener or that it remains healthy. A result marked `verified` is this historical observation, not proof that the whole task passed.

Runtime polling happens in local code, not model requests. Active workers wait for owned processes and consume completion events through their normal loop. A crashed or cancelled worker is not automatically respawned: events remain queued until it is explicitly resumed. The coordinator can inspect and stop project processes. A completion observation is tool data, never new human authorization.

A dead supervisor with an uncertain child becomes `unknown`. Orca never replays that command or kills a possibly reused PID. Unknown and active processes block destructive workspace/project cleanup. Unknown handles require external investigation and repair of recorded state after confirming the real process has stopped; there is no automatic force-forget action. Settled handles with delivered events can be removed with `process forget`.

Capacity is 16 live/unknown processes and 512 retained handles per project. Output is capped per command (64 MiB by default). Completed output, usage history and sandbox scratch space do not yet have automatic age-based retention; explicit process forgetting and operator maintenance reclaim space. Supervisors and tmux are local to the machine running Orca.

## Context, instructions and memory

The coordinator's working brief is `projects/<id>/working-context.json`: goal, decisions, result references and the last three human corrections. The brief is limited to 16 KiB; corrections retain bounded verbatim excerpts with links to their original message IDs. Older result/decision entries can be trimmed to make room for a new correction. Original transcripts remain available.

`/clear` resets the active transcript context and the working brief, preserving explicit saved facts. It refuses pending input or active/unknown coordinator-owned commands. The empty brief is published before the transcript boundary; publication failure restores the prior brief. A process crash between those writes can lose the derived brief, but cannot delete original history or reintroduce an old goal after a completed boundary.

Facts live in `preferences.json` (user) and `projects/<id>/knowledge.json` (project). `remember list/save/forget` exposes them. Only the coordinator mutates shared facts and goals; workers propose changes. Explicit facts require a retained human source ID; this validates provenance, not the correctness of the model's interpretation. Inferences remain tentative. Current instructions override saved knowledge, and memory grants no permission.

Selection retrieves up to eight relevant facts (or `always.*` preferences) within an 8k-character budget. This first implementation uses lexical matching; it is not semantic retrieval or an automatic preference learner. Each scope holds up to 200 facts. Full memory history remains separately searchable through existing archive tools.

Root instructions load once from the Git root to the working directory. AGENTS.md wins over CLAUDE.md in the same folder. `read` surfaces applicable nested instructions. Large instruction sets include a truncation notice and require explicitly reading the remainder. Skills are cataloged from `.agents/skills`, `.claude/skills` and Orca's personal `skills/`; their bodies load through `skill` only when needed. Shell access does not guarantee automatic nested-instruction discovery, so agents must inspect applicable instructions before editing there.

The default `orchestratorContextTokens = 32000` is a compaction target, not a hard total-request ceiling. It accepts 8k–200k; system instructions and pinned intent may exceed the target. Existing `compact = false` still disables compaction. Fresh worker briefs avoid copying coordinator history, while relevant scoped knowledge and the small current goal remain available.

## Execution and tmux

Orca retains one tmux session per project and windows for its agents. Running Orca on a server makes those server-side processes and workspaces persistent across client disconnection. tmux supplies detach/reattach; it is neither a remote scheduler nor a security boundary. This PR does not add cross-host process transport.

`sandbox = "off"` preserves the existing full-access default. Explicit `sandbox = "workspace"` uses macOS sandbox-exec or Linux bubblewrap to restrict writes. Invalid sandbox values, malformed execution configuration or missing platform support fail rather than fall back to full access.

Workers may write their workspace, temporary storage, device files and Git metadata required for worktree commits. Reviewers get temporary storage but no workspace write allowance. Shared Git metadata includes refs and objects: this is not per-ref Git authorization. Read and network access remain available; this profile is not a secret-isolation container. Structured file tools enforce their own narrower path/revision rules. macOS write-denial behavior is exercised locally; Linux bubblewrap needs verification on a supported Linux host.

## Evidence, builds and measurement

`orca version` includes the loaded build ID. Compiled builds record source commit, dirty status and build time; development entry points identify themselves as development builds. `/runtime` distinguishes this UI, its daemon and recorded agent contexts (model, definition hash, context estimate, timestamp). Historical observations are not liveness checks. Build and install remain separate operations; a successful build does not restart existing processes.

`/usage` and the `runtime` tool aggregate `.runtime/usage.jsonl`: input/output/cache/reasoning tokens when available, missing usage, retries, tool durations, supervised-process durations and peak observed context. Model calls used for compaction and search are included when instrumented; requests without an attributable project are exposed separately. Overlapping durations cannot be added to get elapsed wall time. Token counts are not a subscription bill, and failed requests may have unknown provider usage. The file is append-only and contains identifiers/measurements, not prompts or command bodies.

The adaptive evaluation uses scripted providers and temporary projects. It establishes runtime behavior, not model judgment, comparison with Claude Code/Codex, or faster/cheaper task completion. Use the separate efficiency evaluation with comparable real tasks and total orchestration/worker overhead before making performance claims.

## Source attribution

Implementation comments link the specific ideas adapted from primary sources. These are conceptual references, not claims of equivalent behavior or copied implementations:

- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents): focused agent context and concise coordinator results.
- [Claude Code memory](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills): scoped instructions, selected knowledge and lazy skill loading.
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing): OS-backed write boundaries.
- [Codex unified execution](https://github.com/openai/codex/tree/main/codex-rs/core/src/unified_exec): yielding command handles and later output/control.
- [Codex execution server](https://github.com/openai/codex/tree/main/codex-rs/exec-server): execution boundary separation.
- [Codex agent instructions](https://developers.openai.com/codex/guides/agents-md): hierarchical repository instructions.

Orca adds its own durable process event delivery, workspace ownership, source-attributed preference records and optional publication capabilities. No Zeta source is copied into this change.
