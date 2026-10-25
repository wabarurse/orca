# orca-harness — plan

An agent harness built around an orchestrator → worker → reviewer loop, with agents running in tmux sessions that can live locally or in the cloud.

## Core loop

| Role | Job | Done when |
|---|---|---|
| Orchestrator | Works on the default branch in the original checkout, splits work, spawns workers | — |
| Worker | Implements one task and runs only relevant checks once per checked code state | Hands off code and check evidence |
| Reviewer | Reads the diff and failed-check output; runs cyclomatic and cognitive complexity | Reports findings without running tests or editing code |

`spawn` starts a worker-reviewer loop bounded by `maxReviewRounds`. No full test
suites, baseline comparisons or duplicate tests. Review feedback goes to the
worker; only changed checked code permits a rerun. Publication reuses the worker's
evidence and observes hosted checks without a final local validation pass.

## Tools (keep the set small)

| Tool | Notes |
|---|---|
| `bash` | Output capped by byte size. No `sudo`. |
| `spawn` | Starts a worker-reviewer loop |
| message | "Instinct can message" (see open questions) |

## Context

- **Cache:** byte limit on what gets written to the cache.
- **Compaction:** a small LLM summarizes the cache when it fills up.

## System prompts (keep them small)

- Push back a bit and think it through; the user's message is not the final verdict.
- Be concise with the user and use simple terms; agents' reports to the orchestrator are full, with no length limit.
- Use tables for PRs and subagent status.

## Runtime and cloud

- Every agent runs in a tmux session.
- Sessions run in a sandbox: either a separate folder on disk or a Docker container. If sessions are sandboxed, moving them to the cloud is the same thing on another machine.
- Local orchestrators reference the original checkout; workers and reviewers use its Git worktrees. Harness state and conversations live under `~/.orca`.

## UI

- tmux. It is open source (ISC license), so it is fine to build on or ship with.

## Open questions / pushback

1. **"No sudo" by string matching is weak.** Agents can get around it (`su`, scripts, aliases). The real guard is running as a user without sudo inside the sandbox. Keep the check as a nudge, not as security.
2. **Folder vs Docker.** A plain folder does not isolate anything: the agent can still touch the whole machine. Docker gives isolation and makes local and cloud identical, so it is probably the default, with folders as a fast dev mode.
3. **Original checkout, worktree per task branch.** Preserve local configuration and logins by using the existing repository. Reviewers share worker worktrees; conversations sharing the original checkout serialize orchestrator turns.
4. **Compaction loses detail.** A small model will drop things like file paths, error text and decisions. Keep the last N turns verbatim and only summarize older ones; consider pinning key facts (task, branch, PR) outside the summary.
5. **Which cache?** Is the byte limit on tool output stored in context, or on something persisted to disk? They need different limits.
6. **Waiting on CI.** The reviewer needs to wait for CI without burning tokens in a poll loop: block on `gh run watch` or a webhook, not repeated checks.
7. **Reviewer gates.** Pick thresholds for complexity (e.g. flag functions over N) and decide if failing them blocks or just warns.
8. **"Instinct can message"** — what is instinct here? A separate agent, a user-level hook, or the orchestrator? Who can it message?
