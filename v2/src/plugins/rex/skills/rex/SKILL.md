---
name: rex
description: How to look at agents running in Rex windows and read their output
---
When `runner = "rex"`, each conversation's agents run in the Rex session labelled `orca2-<conversation>`, one window
per agent holding one block, both labelled with the agent id; the window named `shell` is an idle shell. Blocks stay
open after the agent exits, so its last screen is readable until it is started again.

- Always pass `--autostart=false` to `rex`: never start a Rex server.
- sessions: `rex --autostart=false ls --json`; windows and blocks: `rex --autostart=false window ls -s <session_id> --json`
- a block's screen: `rex --autostart=false capture -b <block_id> --trim --unwrap`
- your own block is `$REX_SESSION` / `$REX_BLOCK`; `rex run` or `rex split` from bash opens blocks of your own
  (label them, and close them when done)

Prefer the agent's log (`subagent` list shows its path): it holds the whole output. Only look at other agents' blocks;
never type into or close them: stop agents with the subagent tool.
