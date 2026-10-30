# Task dependencies and publication

Task dependencies are explicit project metadata, visible in the task list. They do not schedule agents, authorize work, select a workflow or gate publication.

Orca no longer implements stacked-branch checkpoints, automatic replay/reset, publication attestations, reviewer-only push/create or dependency locks. Use ordinary Git/GitHub tools under the authorized brief and repository instructions. Ask a focused agent for review when useful or required; any authorized agent may publish and attach its verified PR using `task pr`.

Old task/run/evidence records and Git recovery refs remain preserved. The runtime does not execute old stack/replay metadata. Existing workspaces remain reusable; branch updates and cleanup are explicit work. Old workflow tool actions fail as unsupported rather than silently publishing or rewriting branches.

See [architecture](ARCHITECTURE.md) for state ownership and preserved capabilities.
