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

On macOS or Linux with Git, [Bun](https://bun.sh/) 1.4.2+ and [tmux](https://github.com/tmux/tmux), install with:

```sh
curl -fsSL https://raw.githubusercontent.com/wabarurse/parallels/main/install.sh | sh
```

This builds the app in `~/.orca/.runtime/app`, installs `~/.local/bin/orca`, and adds its directory to your bash, zsh, or sh startup file. This version initializes a fresh layout-3 home. Open a new terminal or follow the printed PATH command, then run `orca` from your repo's default branch. Sign in with `/login codex` (also `/login claude` if using claude), and choose a model with `/model`. Update with `orca pull`.

See the [install details](docs/REFERENCE.md#2-install-once) to inspect the script first, skip shell changes, or install manually.

Existing homes are refused without modification. There is no automatic upgrade to layout 3: preserve the stopped old home and initialize a fresh one as described in [home layout and fresh setup](docs/ORCA_HOME.md). The historical migration script only produces layout 2.

Orca uses one adaptive conversation loop: run a small action directly, delegate substantial work with a focused brief, and keep revising the same result. Review and publication remain available when requested. Select a worker in `/agents` and type feedback to it; `/back` returns to the orchestrator. `/runtime` shows loaded build identities and background work; `/usage` shows measured project usage.

See [adaptive execution, personalization and background tools](docs/ADAPTIVE_RUNTIME.md) for the new capabilities, limits and validation instructions.
