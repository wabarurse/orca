# Documentation

Start with the [getting-started guide](../README.md). The [full reference](REFERENCE.md)
retains detailed installation, ownership/recovery, update safety, TUI, workflow,
subscription login, provider implementation and tool guidance.

## Features and behavior

- [Conversation compaction and rolling memory](COMPACTION.md)
- [Clipboard images and agent vision](IMAGE_ATTACHMENTS.md)
- [Model, effort and fast-mode settings](MODEL_SETTINGS.md)
- [Shared session refresh and prompt delivery](SESSION_REFRESH.md)
- [Task and question inbox](TASK_INBOX.md)
- [Native subscription web search](WEB_SEARCH.md)

## Design and evidence

- [Harness design plan](PLAN.md)
- [Terminal selection and isolation](TERMINAL_ISOLATION.md): current behavior first,
  followed by historical investigations retained as evidence, not current UX.
- [Efficiency evaluation report](../evals/efficiency/REPORT.md) and
  [method](../evals/efficiency/METHOD.md); results remain beside the evaluation.
- [Agent/developer guidance](../CLAUDE.md) remains at the repository root.

Unless a link says otherwise, source paths written in these documents (such as
`src/` or `scripts/`) are relative to the repository root, not this directory.
The source layout (packages, the import order inside them, the barrel rule and
the size gates) is described in the Layout section of [CLAUDE.md](../CLAUDE.md)
and enforced by `src/organization.test.ts`; when a document names a deep file,
code outside that folder imports it through the folder's `index.ts` barrel.
