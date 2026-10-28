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

This builds the app in `~/.orca/.runtime/app`, installs `~/.local/bin/orca`, and adds its directory to your bash, zsh, or sh startup file. Existing settings, logins, and conversations are preserved. Open a new terminal or follow the printed PATH command, then run `orca` from your repo's default branch. Sign in with `/login codex` (also `/login claude` if using claude), and choose a model with `/model`. Update with `orca pull`.

See the [install details](docs/REFERENCE.md#2-install-once) to inspect the script first, skip shell changes, or install manually.

Upgrading an existing installation? See [the rename notes](docs/REFERENCE.md#upgrading-to-orca) to keep your saved logins and conversations.

Existing homes require a coordinated offline upgrade before this version starts: [layout and manual migration](docs/ORCA_HOME.md). Do not run the bootstrap installer to migrate a live home.

Orca uses one adaptive conversation loop: run a small action directly, delegate substantial work with a focused brief, and keep revising the same result. Review and publication remain available when requested. Select a worker in `/agents` and type feedback to it; `/back` returns to the orchestrator. `/runtime` shows loaded build identities and background work; `/usage` shows measured project usage.

See [adaptive execution, personalization and background tools](docs/ADAPTIVE_RUNTIME.md) for the new capabilities, limits and validation instructions.
