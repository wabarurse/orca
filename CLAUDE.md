# parallels

A light-context agent harness: orchestrator → worker → reviewer loop, each agent in a tmux window. See PLAN.md for the design.

Bun + TypeScript. Use `bun` for everything (`bun test`, `bun run check`, `bun src/cli.ts`). No Node, npm or vite.

Layout:

- `src/cli.ts` — `start`, `msg`, `agent`, `version` commands; the REPL has `/agents`, `/attach <name>` (live transcript view, `/back` to return)
- `src/view.ts` — renders and follows a transcript for the terminal
- `src/agent.ts` — the loop; all three roles are this with a different prompt and tool set
- `src/transcript.ts` — append-only JSONL with parent pointers
- `src/tools/` — `bash`, `spawn`, `message`; keep the set small
- `src/runner.ts` — worktree + tmux backend
- `src/inbox.ts` — inbox/outbox message files; with the transcripts, the only state on disk

There are no system prompts. Each agent gets its task from the first user message (spawn's brief or the inbox) and the tool descriptions, so keep those descriptions precise.

Rules:

- All state lives under `~/.parallels` (`src/config.ts` has the layout). `PARALLELS_HOME` overrides it in tests.
- No task list. Everything is keyed by branch: `spawn(prompt, branch, role)` seeds `transcripts/<role>-<branch>.jsonl` and starts the agent in `worktrees/<branch>`.
- Agents only know their cwd. Never read the host or another worker's worktree.
- Tool results are byte-capped when appended to the transcript.
- Prefer `Bun.file`, `Bun.$`, and `bun:test` over npm packages.
