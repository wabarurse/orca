# Orca: minimal execution, personalized coordination

Orca follows Pi's separation of agent execution from workflow policy. One shared agent loop handles model streaming, tools, inbox steering and compaction. The terminal is a client of the persistent conversation runtime; a future desktop client can use the same command/event boundary.

## Runtime boundaries

- Providers resolve the project's account, model and request settings. Role-specific model overrides remain supported.
- The loop assembles bounded context, requests the model, executes tools and emits events. It settles when authorized work ends. No fixed exploration, implementation, review or CI loop is selected.
- Tools provide read/edit/write, bash, supervised processes, search and lightweight coordination. Background commands have owners and send events without model polling.
- Delegation starts a focused session, delivers feedback to its owner, returns concise results and supports cancellation. New sessions receive a brief and relevant instructions rather than copied coordinator history. Existing workspaces support iteration.
- Worker/reviewer are prompt and model-selection presets over the same implementation. A reviewer defaults to inspection; its brief can authorize checks, edits or publication. No role owns exclusive publication authority.
- Sessions retain original transcripts and artifacts while projecting a bounded model context. Orchestrator rolling compaction remains unchanged, including background summaries and publication fences. Worker compaction retains its independent working-context target.
- Lifecycle mechanics own process admission, cancellation, durable delivery and recovery. Current hosting uses tmux; task policy and durable application state do not live in tmux. This change does not introduce a second hosting backend.

## User features retained

Tasks keep stable numbers, progress, ownership, explicit dependency metadata, optional exact-head evidence and PR links. Inboxes retain agent messages, questions and decisions. Project/conversation switching, pinning, names, provider/account/model selection, reasoning effort and fast settings remain available. Image attachments, runtime diagnostics, usage reporting, remote reconnect and global updates remain supported.

The PR watcher observes linked task PRs and sends durable merge notifications. It never terminates agents or modifies branches/workspaces. A conversation with no linked PRs performs no PR queries. Retained merged task records can drain an interrupted notification without re-querying GitHub.

## State ownership

| Responsibility | Authority |
| --- | --- |
| Original conversation and tool-result references | Transcript |
| Task identities, membership, dependencies and records | SQLite task ledger; tasks.json is a projection |
| Preferences and project/account/model settings | Scoped SQLite records |
| Current coordination brief | One bounded project record |
| Large tool outputs and reports | Artifact files |
| Process ownership, admission, delivery and stop barriers | Durable runtime records |
| UI/history caches and indexes | Rebuildable projections |

Compaction summaries are lossy context projections, never new authorization or a replacement for originals. No cache hit removes a model's need for relevant input context.

## Workflow policy

Review, tests, CI observation, branch updates and publication follow the user's brief and repository instructions using existing tools. Personalization lives in editable instructions, skills and scoped preferences. No new plugin framework is introduced.

Removed: dynamic dispatch, review-round settings, the complexity scorer, stacked-branch checkpoints/replay, dependency publication gates, reviewer-only publication and automatic post-merge cleanup. Task dependency edges remain metadata; they never independently start work. Optional readiness annotations are head-bound observations and never gate publication or grant merge permission.

Existing task/run records, evidence, workspaces and recovery refs are preserved. Old stack metadata and project flow settings are inert. Retired global settings are ignored and disappear on the next config save. Shipped prompt/tool defaults update through existing provenance tracking; user-edited definitions remain on disk. Removed workflow actions are refused; they never silently rewrite a branch or publish.

Ctrl+C stops the selected conversation tree, retries, compaction and its commands. Only fresh human input resumes it. Other conversations remain independent. Disconnecting a client preserves authorized remote work. Filesystem observations and historical records cannot release the stop barrier.

## Reference and validation

Pi source inspected at [a14cdf90](https://github.com/earendil-works/pi/tree/a14cdf90f0a76532f3e20bc3c01872837cef24ba): [agent loop](https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/agent/src/agent-loop.ts), [prompt construction](https://github.com/earendil-works/pi/blob/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/coding-agent/src/core/system-prompt.ts), and [customization boundaries](https://github.com/earendil-works/pi/tree/a14cdf90f0a76532f3e20bc3c01872837cef24ba/packages/coding-agent). Orca retains its coordination features; no Pi source was copied and no comparative performance ranking is claimed.

Regression coverage checks cancellation and rapid resume, rolling compaction, task/state preservation, project isolation, generic delegation and merge notifications without workspace mutation. Performance uses the existing synthetic idle benchmark; real model cost and task completion latency require representative workload measurements and are not inferred from deleted line counts.
