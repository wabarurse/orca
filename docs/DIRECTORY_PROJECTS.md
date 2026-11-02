# Directory projects and conversations

A project is a stable UUID, a display name, a directory reference and default settings. Conversations belong to that project and retain separate UUIDs, histories, tasks, inboxes, working briefs and execution lifetimes. Conversations sharing the same canonical checkout belong to one project; sharing a remote URL does not combine different checkouts.

`/projects` lists directory projects. Enter opens that project's conversations; `n` creates another conversation there, and Esc returns to the project list. Conversation titles may already be duplicated in imported data; the picker includes storage IDs to distinguish them. Project rows reflect activity in their open conversations without reading storage during rendering.

The first supported directory source remains an original Git checkout. Worker worktrees belong to conversations and do not become additional projects. This change does not move repositories, transcripts or workspaces.

## Startup and execution

Starting inside a known checkout automatically opens the conversations belonging to that directory project, preferring the saved selection when it belongs there. No startup-selection command is required, and saved views from unrelated directories are not opened. Outside a known checkout, startup restores the last open conversations and selection. An unknown directory offers an explicit `/new <name> <directory>` action instead of creating an empty conversation automatically.

Opening or polling a restored view does not start its daemon, run queued work or revive workers. Already-running remote work can still be observed. Fresh human input starts execution for that conversation; persistent stop barriers still require that input. Closing a terminal preserves authorized remote work.

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
- `/project relink <directory>` validates a new original checkout before changing the directory reference. Active conversation turns, agents and unresolved commands block relinking. Validation failure leaves the old reference unchanged. Relinking changes metadata, not workspace contents.

Missing directories remain listed and conversations remain readable. Relink explicitly when a checkout moves; Orca does not infer identity from a remote URL or silently bind another repository.

## Persistence and compatibility

`memory.sqlite` stores the directory catalog, defaults and open-view preference. Each conversation stores a small `.identity.json` beside its artifacts. That UUID travels with a complete folder restore; deleting and recreating a folder without its identity creates a new conversation. Include hidden metadata files in backups.

Existing `projects/<orch-id>/` paths remain conversation artifact paths for compatibility. Their IDs, task ledger associations, transcripts and runtime routes are retained. Logical project grouping does not require a destructive on-disk layout migration or a reinstall.

Older layout-3 state used `device:inode:birth-time` in settings keys. Device numbers can change across macOS restarts. A UUID's compatibility lookup uses the original inode/birth fingerprint, ignores the volatile device number and rejects conflicting legacy values. Per-key overrides use the UUID namespace; legacy values stay readable for keys not yet overridden, including late writes from old agents finishing an update. Explicit clears cannot resurrect legacy settings. Older layout versions retain their existing offline recovery requirements.

Stop/control identity comes from the filesystem UUID rather than the settings database. A broken task/settings database cannot prevent publishing cancellation. Legacy stop/process records still match the original fingerprint, preserving stopped status across the upgrade.

No live state is reset by this PR. Update with `orca pull` after merge and reopen old TUIs. Older workers finish on their loaded build; originals and task records remain intact.

Task-ledger bindings remain immutable. Readers and writers recognize the original filesystem fingerprint as the same conversation UUID only when repository and worktree identity still match. Validated explicit relinks record prior directory/branch routes; unapproved binding changes and recreated conversations still require recovery. No task rows or task numbers are rewritten to perform this compatibility check.

Retained image references also keep their original scope hashes. Before loading a pre-UUID image, Orca checks historical state namespaces for the conversation's original fingerprint and reconstructs only those proven identity hashes. Images are still checked against their saved byte hash and format. A copied image file alone grants no access; other conversations and deleted/recreated aliases remain rejected. New images use UUID scopes. This compatibility lookup does not rewrite transcripts, input journals, image bytes or state rows, and does not require re-uploading retained attachments.
