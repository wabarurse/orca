# parallels

A light-context agent harness: orchestrator → worker → reviewer loop, each agent in a tmux window. See PLAN.md for the design.

Bun + TypeScript. Use `bun` for everything (`bun test`, `bun run check`, `bun src/cli.ts`). No Node, npm or vite.

Layout:

- `src/cli.ts` — `start [project] [git-url]`, `msg`, `agent`, `version` commands. `start` opens the full-screen TUI
- `src/tui/` — the bare full-screen TUI: `app.ts` (one page per orchestrator; Ctrl+N starts `orch-xxxx` at once, `/rename <name>`, Ctrl+, / Ctrl+. switch, Alt+, / Alt+. fallback; `/help` lists the commands: `/agents` picks a transcript to view live, `/back`, `/models [id]`, `/accounts`, `/login claude [profile] | codex [profile]` (aliases: anthropic/openai), `/new [name] [git-url]`, `/close`, `/quit`), `render.ts` (pure frame → escape codes), `keys.ts` (legacy, xterm modifyOtherKeys and kitty key parsing), `term.ts` (raw mode, alternate screen)
- `src/commands.ts` — what the slash commands do, separate from how the TUI shows them
- `src/providers/` — `Provider` interface over an Anthropic-shaped transcript; `anthropic.ts` (SDK) and `openai.ts` (Codex subscription Responses, translated; preserves encrypted reasoning and tool IDs). `providerFor(model)`: `claude*` → anthropic, else openai
- `src/accounts.ts` — subscription accounts only: config `account` selects a Claude profile, `openaiAccount` selects a Codex profile; empty means `default`. API keys, old saved keys, developer-platform profiles and billing fallbacks are unsupported.
- `src/claude-auth.ts` / `src/codex-auth.ts` — provider-specific OAuth login, import and refresh. `src/oauth.ts` shares PKCE callbacks, private atomic writes and cross-process locks. State is under `auth/anthropic/` or `auth/openai/`. Tests use temporary homes and fake tokens, never native credentials.
- `src/view.ts` — renders and follows a transcript for the terminal
- `src/agent.ts` — the loop; all three roles are this with a different prompt and tool set
- `src/transcript.ts` — append-only JSONL with parent pointers
- `src/tools/` — `bash`, `spawn`, `message`; keep the set small
- `src/runner.ts` — worktree + tmux backend
- `src/inbox.ts` — one FIFO inbox per agent (`inbox/<agent>/`, a file per message); with the transcripts, the only state on disk. `message` sends to any address: `orchestrator`, `user`, or an agent id. Agents read their inbox before the first request, after each tool call (delivered with the tool results, never interrupting one), and after every turn, and keep going while messages arrive

Each agent gets its task from the first user message (spawn's brief or the inbox) and the tool descriptions, so keep those descriptions precise. The providers add only their Claude Code/Codex compatibility identity; there are no role-specific system prompts.

Rules:

- All state lives under `~/.parallels` (`src/config.ts` has the layout). `PARALLELS_HOME` overrides it in tests.
- No task list. Everything is keyed by branch: `spawn(prompt, branch, role)` seeds `transcripts/<role>-<branch>.jsonl` and starts the agent in `worktrees/<branch>`.
- Agents only know their cwd. Never read the host or another worker's worktree.
- Tool results are byte-capped when appended to the transcript.
- Prefer `Bun.file`, `Bun.$`, and `bun:test` over npm packages.
