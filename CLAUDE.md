# parallels

A light-context agent harness: orchestrator → worker → reviewer loop, each agent in a tmux window. See PLAN.md for the design.

Bun + TypeScript. Use `bun` for everything (`bun test`, `bun run check`, `bun src/cli.ts`). No Node, npm or vite.

Layout:

- `src/cli.ts` — `start`, `msg`, `agent`, `version` commands; the REPL has `/agents`, `/attach <name>` (live transcript view, `/back` to return), `/models [id]`, `/accounts`, `/use <account>`, `/login anthropic [profile] | openai`
- `src/providers/` — `Provider` interface over an Anthropic-shaped transcript; `anthropic.ts` (SDK) and `openai.ts` (chat completions, translated). `providerFor(model)`: `claude*` → anthropic, else openai
- `src/accounts.ts` — who is signed in: named Claude subscription OAuth profiles (config `account` selects one, empty means `default`; `ANTHROPIC_API_KEY` overrides all with API billing); OpenAI via `OPENAI_API_KEY` or a key saved by `/login openai` in `~/.parallels/credentials.json` (0600)
- `src/claude-auth.ts` — browser PKCE login, explicit `--from-claude-code` import, private credential storage under `auth/anthropic/`, and refresh serialized across worker processes. Never fall back to developer-platform `ant` profiles. Tests use temporary homes and fake tokens, never the real keychain.
- `src/view.ts` — renders and follows a transcript for the terminal
- `src/agent.ts` — the loop; all three roles are this with a different prompt and tool set
- `src/transcript.ts` — append-only JSONL with parent pointers
- `src/tools/` — `bash`, `spawn`, `message`; keep the set small
- `src/runner.ts` — worktree + tmux backend
- `src/inbox.ts` — one FIFO inbox per agent (`inbox/<agent>/`, a file per message); with the transcripts, the only state on disk. `message` sends to any address: `orchestrator`, `user`, or an agent id. Agents read their inbox before the first request and after every turn, and keep going while messages arrive

Each agent gets its task from the first user message (spawn's brief or the inbox) and the tool descriptions, so keep those descriptions precise. The Anthropic provider adds only the required Claude Code compatibility identity for subscription requests; there are no role-specific system prompts.

Rules:

- All state lives under `~/.parallels` (`src/config.ts` has the layout). `PARALLELS_HOME` overrides it in tests.
- No task list. Everything is keyed by branch: `spawn(prompt, branch, role)` seeds `transcripts/<role>-<branch>.jsonl` and starts the agent in `worktrees/<branch>`.
- Agents only know their cwd. Never read the host or another worker's worktree.
- Tool results are byte-capped when appended to the transcript.
- Prefer `Bun.file`, `Bun.$`, and `bun:test` over npm packages.
