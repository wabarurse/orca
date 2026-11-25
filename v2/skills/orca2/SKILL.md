---
name: orca2
description: Use the orca2 CLI from bash - the chat's model, effort, fast mode, runner, compaction, conversations, bubbles, plugins (list, install, enable, configure), MCP servers, accounts, spans, cleanup
---
Run `orca2 skill` and follow the guide it prints. It comes from the installed orca2, so it matches the commands this
version has. If it fails, start with `orca2 help` and `orca2 plugin help`.

What to keep in mind beyond that guide:

- Your own conversation is `$ORCA_CONVERSATION`; pass it with `--conversation` rather than relying on the folder.
- Plugin commands default to this conversation's bubble; `--global` only when the user asks for a global change.
- `--yes` only for an install or update the user requested; then verify with `orca2 plugin list --json`.
- After changing an installed plugin run `orca2 plugin update <name> --yes` (not `enable`); a running chat keeps the
  old version until `/stop` and a reopen of orca2.
- Never run `delete`, `stop`, `kill`, `clean`, `pull` or `login` unless the user asked for exactly that.
- The TUI's slash commands that change something (`/model`, `/effort`, `/fast`, `/mux`, `/compact`, ...) are orca2
  commands too, with the same code; run them only when the user asks for that change.
- To write or change a plugin, load the `orca-plugin` skill.
