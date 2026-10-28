# Orca design

Orca uses one adaptive agent loop for coordinators, workers and reviewers. The model selects capabilities from the current request, evidence, permissions and unfinished work. There are no hardcoded direct/iterate/ship modes and ordinary delegation does not create publication tasks.

The orchestrator keeps a small working brief and delegates substantial investigation, implementation and debugging. Workers start with focused context, retain their workspace for feedback, and can receive a fresh context handoff on that same branch. Detailed evidence stays in artifacts and transcripts; concise results return to the coordinator. Current human corrections take precedence over lossy historical summaries.

Processes have durable ownership and observations. Long commands return handles; supervisors capture bounded output, deliver readiness/completion events, accept input and cancellation, and never replay a command merely because its supervisor vanished. Waiting does not issue model requests. Publication remains an explicit capability with existing task/dependency/check/merge safeguards.

A tmux session per project contains agent windows. Running Orca on a server gives persistent remote execution through that server's processes and filesystem. tmux provides detach/reattach; it does not provide remote scheduling or a security boundary.

The implemented design, source attribution, settings, tests and limitations are in [ADAPTIVE_RUNTIME.md](ADAPTIVE_RUNTIME.md). The existing [efficiency evaluation](../evals/efficiency/METHOD.md) remains separate from the deterministic [adaptive workflow evaluation](../evals/adaptive/METHOD.md). New performance/quality claims require new measured comparisons.
