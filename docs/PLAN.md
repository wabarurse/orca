# parallels-harness — plan

An agent harness built around an orchestrator → worker → reviewer loop, with agents running in tmux sessions that can live locally or in the cloud.

## Core loop

| Role | Job | Done when |
|---|---|---|
| Orchestrator | Works on the default branch in the original checkout, splits work, spawns workers | — |
| Worker | Implements one task on its own branch | Hands off to reviewer |
| Reviewer | Judges actual diff/risk; relevant checks and complexity for changed JS/TS logic where applicable | Exact clean PR head validated with evidence (no CI is not validation), then reports to orchestrator |

`spawn` starts a worker-reviewer loop. Trivial wording/formatting in README/docs/comments may go directly to `reviewMode: "watch-ci"` for publication and bounded text/link checks, without a formal review round, complexity call or full app suite. Behavior/security/config, agent instructions and executable examples need substantive risk review even in Markdown; extension alone is not a risk classification. `maxReviewRounds` caps substantive review (0 disables rounds, not validation). Material review needs discovered in watch-ci return to the orchestrator when rounds are enabled, respecting the cap and disclosing exhausted-budget exceptions. Only explicitly tagged review dispatches count as rounds.

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
- Local orchestrators reference the original checkout; workers and reviewers use its Git worktrees. Harness state and conversations live under `~/.parallels`.

## UI

- tmux. It is open source (ISC license), so it is fine to build on or ship with.

## Open questions / pushback

1. **"No sudo" by string matching is weak.** Agents can get around it (`su`, scripts, aliases). The real guard is running as a user without sudo inside the sandbox. Keep the check as a nudge, not as security.
2. **Folder vs Docker.** A plain folder does not isolate anything: the agent can still touch the whole machine. Docker gives isolation and makes local and cloud identical, so it is probably the default, with folders as a fast dev mode.
3. **Original checkout, worktree per task branch.** Preserve local configuration and logins by using the existing repository. Reviewers share worker worktrees; conversations sharing the original checkout serialize orchestrator turns.
4. **Compaction loses detail.** A small model will drop things like file paths, error text and decisions. Keep the last N turns verbatim and only summarize older ones; consider pinning key facts (task, branch, PR) outside the summary.
5. **Which cache?** Is the byte limit on tool output stored in context, or on something persisted to disk? They need different limits.
6. **Waiting on CI.** The reviewer needs to wait for CI without burning tokens in a poll loop: block on `gh run watch` or a webhook, not repeated checks.
7. **Reviewer gates.** Configured thresholds flag relevant measured complexity; unchanged functions are baseline context, not regressions. Unsupported/failed analysis is not zero. Reviewers judge findings by risk rather than treating every flag as a blocker.
8. **"Instinct can message"** — what is instinct here? A separate agent, a user-level hook, or the orchestrator? Who can it message?
