---
name: rex
description: How agents and background commands run in Rex, and how to find and read them
---
When `runner = "rex"` (or a spawn passed `runner: "rex"`), every agent, background command and the orchestrator runs as a
hidden Rex block: a terminal in the Rex server with no tab, labelled `<agent>@<conversation>` (a command is
`proc-<id>@<conversation>`). When the user runs orca2 inside Rex they live in the user's own Rex session, otherwise in
the session labelled `orca2-<conversation>`. They keep running until stopped; nothing opens in the user's Rex app.

- Always pass `--autostart=false` to `rex`: never start a Rex server.
- Find them: `rex --autostart=false api call session.list_blocks '{"session_id":"<session>"}'` lists every block,
  hidden ones included (`window ls` shows only blocks in tabs). Sessions: `rex --autostart=false ls --json`.
- Read one: `rex --autostart=false capture -s <session> -b <block_id> --format text --trim`.
- The user watches one in orca2 itself: Enter on its row in the Agents or Processes tab shows its terminal in place,
  keys go to it, q or Esc returns. To let the user see an agent, tell them to press Enter on its row.

Prefer the agent's log (`subagent` list shows its path): it holds the whole output. Never open a tab for these blocks,
move them, type into them or close them: closing a block ends its program. Stop agents with the subagent tool and
commands with the process tool.
