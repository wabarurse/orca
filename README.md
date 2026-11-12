# orca

```text
                                       #,
                                       ###
                                       ####
                                       #####
                                       ######
                                      ########,
                                ,,################,,,,,
                          ,,#################################,,
                     ,,##########################################,,
                  ,#########################################, ''#####,
               ,#############################################,,   '####,
             ,##################################################,,,,####,
           ,###########''''           ''''###############################
         ,#####''   ,,,,##########,,,,          '''####'''          '####
       ,##' ,,,,###########################,,,                        '##
      ' ,,###''''                  '''############,,,
    ,,##''                                '''############,,,,        ,,,,,,###''
 ,#''                                            '''#######################'''
'                                                          ''''####''''
```

Orca works in any local directory. It automatically opens that directory's
conversations or creates its first. GitHub and a Git repository are optional.
Workers in ordinary directories share the folder; Git projects use isolated
worker worktrees. PR and hosted-check features require an appropriate remote.

On macOS or Linux with Git (for installation and updates), [Bun](https://bun.sh/) 1.4.2+ and [tmux](https://github.com/tmux/tmux), install with:

```sh
curl -fsSL https://raw.githubusercontent.com/wabarurse/parallels/main/install.sh | sh
```

This builds the app in `~/.orca/.runtime/app`, installs `~/.local/bin/orca`, and adds its directory to your bash, zsh, or sh startup file. This version initializes a fresh layout-3 home. Open a new terminal or follow the printed PATH command, then run `orca` from your repo's default branch. Sign in with `/login codex` (also `/login claude` if using claude), and choose a model with `/model`.

Run `orca pull` from any directory to update the global installation and reload running orchestrators after their current turns finish. Reopen existing TUIs for interface updates; workers and reviewers finish on their loaded builds. Progress is in `~/.orca/.runtime/updates.log`. When upgrading from a version that predates automatic reloads, run `orca reload` once after the first pull. See [update behavior and recovery](docs/REFERENCE.md#explicit-updates-orca-pull).

See the [install details](docs/REFERENCE.md#2-install-once) to inspect the script first, skip shell changes, or install manually.

Existing homes are refused without modification. There is no automatic upgrade to layout 3: preserve the stopped old home and initialize a fresh one as described in [home layout and fresh setup](docs/ORCA_HOME.md). The historical migration script only produces layout 2.

Orca uses one adaptive conversation loop: run a small action directly, delegate substantial work with a focused brief, and keep revising the same result. Review and publication remain available when requested. Ctrl+A opens the page of agents, tasks, questions, images and projects: select a worker there, press Enter and type feedback to it; Esc returns to the orchestrator.

See [adaptive execution, personalization and background tools](docs/ADAPTIVE_RUNTIME.md) for the new capabilities, limits and validation instructions.

Architecture follows a small execution core with personalized instructions and skills. Tasks, inboxes, project model/account settings and rolling compaction remain first-class features; review and publication have no mandatory workflow. PR merge notifications preserve agents and workspaces. See [architecture and simplification](docs/ARCHITECTURE.md).

Projects reference directories; conversations keep separate histories, tasks and inboxes. Startup restores views without starting agent work. See [directory projects, startup selection and recovery](docs/DIRECTORY_PROJECTS.md).
