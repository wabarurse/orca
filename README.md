# parallels

A simple, light-context agent harness with an orchestrator → worker → reviewer loop.

```bash
bun install
bun src/cli.ts start <project>
```

Everything lives under `~/.parallels`. Design notes are in [PLAN.md](PLAN.md).

## Claude subscription login

In the REPL, sign in with a Claude Pro/Max account:

```text
/login anthropic personal
/accounts
/use anthropic:personal
```

Login opens `claude.ai` in your browser and receives the OAuth callback on
`localhost:53692`. The browser must run on the same machine as parallels.
Omit the profile name to use `default`; repeat with another name for another account.
The selected account takes effect on the next orchestrator turn. Running workers
keep their selected account and refresh its tokens automatically.

To bootstrap a profile from an existing Claude Code login:

```text
/login anthropic personal --from-claude-code
```

This copies tokens from `CLAUDE_CONFIG_DIR` (default `~/.claude`) credential files,
or the macOS `Claude Code-credentials` keychain entry when using the default
directory. It does not modify Claude Code's store. For independent refresh tokens,
use the browser login instead of importing an account used concurrently in Claude Code.

Subscription profiles are stored under `~/.parallels/auth/anthropic/` with private
file permissions (0600), atomic replacement, and a per-profile lock shared by
workers. `PARALLELS_HOME` relocates parallels' state. Failed logins leave the
previous profile intact; `/quit` cancels a pending browser login.

This follows [zeta's Claude subscription OAuth implementation](https://github.com/hwang2409/zeta/blob/4ba6ea9af9f5cee1839fdf99df50851d8a1a7cd1/src/zeta/providers/anthropic.py):
Claude Code's public OAuth client ID, PKCE, Bearer authentication,
`claude-code-20250219` / `oauth-2025-04-20` beta headers, and its compatibility
identity in subscription requests. This compatibility path can change upstream.

`ANTHROPIC_API_KEY` explicitly overrides subscription profiles and uses API
billing. `/accounts`, `/login`, and `/use` show that override; unset the variable
to use your subscription. Developer-platform `ant auth login` profiles and
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_PROFILE` are no longer used. Existing users
should run `/login anthropic <name>` once to replace their old profile selection.
There is no fallback from a failed subscription login to API billing.

OpenAI still uses `OPENAI_API_KEY` or `/login openai`.
