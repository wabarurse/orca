# Directory projects and conversations

A project is a stable UUID, a display name, a directory reference and default settings. Conversations belong to that project and retain separate UUIDs, histories, tasks, inboxes, working briefs and execution lifetimes. Conversations sharing the same canonical checkout belong to one project; sharing a remote URL does not combine different checkouts.

`/projects` lists directory projects. Enter opens that project's conversations; `n` creates another conversation there, and Esc returns to the project list. Conversation titles may already be duplicated in imported data; the picker includes storage IDs to distinguish them. Project rows reflect activity in their open conversations without reading storage during rendering.

The first supported directory source remains an original Git checkout. Worker worktrees belong to conversations and do not become additional projects. This change does not move repositories, transcripts or workspaces.

## Startup and execution

Starting inside a known checkout automatically opens the conversations belonging to that directory project, preferring the saved selection when it belongs there. No startup-selection command is required, and saved views from unrelated directories are not opened. A new checkout automatically creates its directory project and opens its first empty conversation; no `/new` command is needed. Reopening it reuses its conversations, including when launched from a subdirectory. Creation does not submit input or start model work. Only when launched outside a Git checkout does startup restore the last open conversations and selection. An explicit conversation argument overrides directory-based startup.

Opening or polling a restored view does not start its daemon, run queued work or revive workers. Already-running remote work can still be observed. Fresh human input starts execution for that conversation; persistent stop barriers still require that input. Closing a terminal preserves authorized remote work.

## Orchestrator coordination

An orchestrator can discover sibling conversations in its canonical checkout with
`runtime({action: "conversations"})`. The result includes names, stable IDs,
`orchestrator@<conversation-id>` addresses, stop observations and queued message
counts. Duplicate or renamed titles do not change the addresses. Different local
checkouts remain separate even when they share a Git remote.

Use `message({to: "orchestrator@orch-xxxx", text: "I own api.ts; are you changing it?"})`
to coordinate authorized work. Sender identity is preserved as
`orchestrator@<sender-id>`, so the receiver can reply to that address. These are
agent reports, not fresh human instructions. Conversation history, tasks, settings
and provider accounts remain separate. Peer messages are text-only; project-scoped
images cannot be forwarded across conversation boundaries.

Messages use the existing durable inbox. A receipt confirms enqueue acceptance,
not processing, and never starts or restarts a daemon. An existing unpaused daemon
can consume them on its next turn. Stopped conversations retain queued messages
until fresh human input resumes them; exited daemons are not automatically
launched. Conversations on the same checkout can run turns concurrently. Finish
the sending turn without polling for a reply or exchanging empty acknowledgments.

Reports over 2000 characters require a concise `summary`. Full text is saved in
the recipient's evidence directory for bounded reads; only the summary and path
enter its context. Recipient identity and checkout membership are checked again
under the publication lock, rejecting changed/deleted conversations and relinks.

`orca startup <conversation-name>` optionally saves the conversations restored when starting outside a known checkout, without deleting anything. It retains every exact title match, including duplicate titles. A storage ID can select one conversation. `orca startup --all` restores all discoverable conversations again. Directory projects and closed conversations remain available in `/projects`.

For the two existing `phoebe-agent-notes` conversations, after merging and updating:

```sh
orca pull
cd ~/Documents/phoebe/phoebe
orca
```

This retains both conversations referencing `~/Documents/phoebe/phoebe`; their task lists remain separate. Other history is retained rather than removed.

## Settings and relinking

Existing conversation-specific account/model/role/effort/fast settings are preserved. The first conversation attached to a directory seeds its defaults; later conversations inherit missing settings. An explicit conversation override wins over directory defaults, which win over global defaults. Working briefs, tasks and inboxes never inherit across conversations.

- `/model`, `/accounts`, `/effort` and `/fast` retain their conversation behavior.
- `/project-defaults save` promotes the selected conversation's saved preferences to directory defaults.
- `/project-defaults inherit` clears its local setting overrides so it follows the directory defaults again.
- `/project` shows the directory project's identity and location.
- `/project rename <name>` changes the directory project's display name; `/rename` names the conversation.
- `/project relink <directory>` validates a new original checkout before changing the directory reference. Active conversation turns, agents and commands that may still be running block relinking. Validation failure leaves the old reference unchanged. Relinking changes metadata, not workspace contents.

Conversation deletion and directory relinking inspect recorded command supervisors, command PIDs and process groups. An old `unknown` result does not block them once all three are confirmed gone; the result remains unknown, not successful. Live processes, permission errors and missing process identities still block the action, with the command ID and reason in the error. These checks do not stop commands, retry them or send events to agents.

Missing directories remain listed and conversations remain readable. Relink explicitly when a checkout moves; Orca does not infer identity from a remote URL or silently bind another repository.

## Persistence and compatibility

`memory.sqlite` stores the directory catalog, defaults and open-view preference. Each conversation stores a small `.identity.json` beside its artifacts. That UUID travels with a complete folder restore; deleting and recreating a folder without its identity creates a new conversation. Include hidden metadata files in backups.

Existing flat `projects/<orch-id>/` paths remain readable until the explicit offline organization described below. Conversation IDs, task ledger associations, transcripts and runtime routes are retained. A reinstall is not required.

Older layout-3 state used `device:inode:birth-time` in settings keys. Device numbers can change across macOS restarts. A UUID's compatibility lookup uses the original inode/birth fingerprint, ignores the volatile device number and rejects conflicting legacy values. Per-key overrides use the UUID namespace; legacy values stay readable for keys not yet overridden, including late writes from old agents finishing an update. Explicit clears cannot resurrect legacy settings. Older layout versions retain their existing offline recovery requirements.

Stop/control identity comes from the filesystem UUID rather than the settings database. A broken task/settings database cannot prevent publishing cancellation. Legacy stop/process records still match the original fingerprint, preserving stopped status across the upgrade.

No live state is reset by this PR. Update with `orca pull` after merge and reopen old TUIs. Older workers finish on their loaded build; originals and task records remain intact.

Task-ledger bindings remain immutable. Readers and writers recognize the original filesystem fingerprint as the same conversation UUID only when repository and worktree identity still match. Validated explicit relinks record prior directory/branch routes; unapproved binding changes and recreated conversations still require recovery. No task rows or task numbers are rewritten to perform this compatibility check.

Retained image references also keep their original scope hashes. Before loading a pre-UUID image, Orca checks historical state namespaces for the conversation's original fingerprint and reconstructs only those proven identity hashes. Images are still checked against their saved byte hash and format. A copied image file alone grants no access; other conversations and deleted/recreated aliases remain rejected. New images use UUID scopes. This compatibility lookup does not rewrite transcripts, input journals, image bytes or state rows, and does not require re-uploading retained attachments.

## Named project folders

The public folder view follows directory projects and conversation titles:

```text
projects/
  phoebe--a1b2c3d4/
    project.json
    conversations/
      phoebe-agent-notes--369l -> ../../.conversations/orch-369l
      phoebe-agent-notes--5xab -> ../../.conversations/orch-5xab
  .conversations/                # hidden stable storage; retain in backups
    orch-369l/
    orch-5xab/
```

Opening a named conversation link opens its actual tasks, history, outputs and images. The short suffix distinguishes duplicate titles and same-named checkouts. Names are sanitized for filesystem use. `/rename` updates the conversation link; `/project rename` updates the directory group. The actual artifact path stays fixed so open transcripts and running agents remain valid. Generated `project.json` and links are a readable view; catalog/UUID records remain authoritative. An unchanged view requires no rewrite, and user-added regular files in the view are retained.

Fresh homes use this structure automatically. Existing flat homes remain supported until a deliberate one-time migration. **Do not run it while your agents are working.** Once they have finished, close all Orca TUIs and stop its tmux sessions, then run:

```sh
orca organize
```

The command checks host participants, tmux panes, durable ownership locks and supervised commands before moving anything; unknown state refuses too. It never signals, stops, restarts or resumes an agent. It excludes new launches while organizing and can resume after interruption. A same-filesystem rename retains the directory fingerprint, and task SQL bindings, transcript bytes and image references are preserved. In-folder legacy Git clones/worktrees are refused because moving them could break Git's absolute paths. `orca pull` updates code and does **not** run this migration. After migration, older binaries/TUIs must stay closed; use the updated Orca to reopen conversations.
