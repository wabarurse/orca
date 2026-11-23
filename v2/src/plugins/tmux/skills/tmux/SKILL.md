---
name: tmux
description: How to look at agents running in tmux windows (orca2's own tmux server) and read their output
---
When `runner = "tmux"`, each conversation's agents run in the tmux session `orca2-<conversation>` on orca2's own
server, one window per agent named after its id (`orchestrator`, `worker-<branch>`, ...). It is never the default
tmux server, so plain `tmux ls` does not show it; always pass the socket:

- socket: `-S "${ORCA2_HOME:-$HOME/.orca2}/.runtime/tmux.sock"` (when that path is over 100 bytes, `-L orca2`)
- windows: `tmux -S <socket> list-windows -t orca2-$ORCA_CONVERSATION -F '#{window_name}'`
- an agent's screen: `tmux -S <socket> capture-pane -p -J -S -200 -t "orca2-$ORCA_CONVERSATION:=<agent>"`
- the user watches with `tmux -S <socket> attach -t orca2-<conversation>`

Prefer the agent's log (`subagent` list shows its path): it holds the whole output, the window only what is on screen.
Only look; never type into, kill or rename another agent's window: stop agents with the subagent tool.
