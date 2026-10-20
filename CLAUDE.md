# parallels

A light-context agent harness: orchestrator → worker → reviewer loop, each agent in a tmux window. See PLAN.md for the design.

Bun + TypeScript. Use `bun` for everything (`bun test`, `bun run check`, `bun src/cli.ts`). No Node, npm or vite.

Layout:

- `src/cli.ts` — `start`, `msg`, `agent` commands
- `src/agent.ts` — the loop; all three roles are this with a different prompt and tool set
- `src/transcript.ts` — append-only JSONL with parent pointers
- `src/tools/` — `bash`, `spawn`, `message`; keep the set small
- `src/runner.ts` — worktree + tmux backend
- `src/tasks.ts`, `src/inbox.ts` — the only state: `tasks.json` and inbox files
- `prompts/` — default system prompts, one per role, each under a page

Rules:

- All state lives under `~/.parallels` (`src/config.ts` has the layout). `PARALLELS_HOME` overrides it in tests.
- Agents only know their cwd. Never read the host or another worker's worktree.
- Tool results are byte-capped when appended to the transcript.
- Prefer `Bun.file`, `Bun.$`, and `bun:test` over npm packages.
