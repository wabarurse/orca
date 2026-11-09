# Session transfer: `orca session`

Move a whole project (its conversation) between two machines, or through a file, without losing or merging away
history. Unrelated to `orca pull`, which updates orca itself.

```
orca session ls [host]                          projects here, or on host (over ssh)
orca session push <project> <host> [--as <name>] [--checkout <dir on host>] [--adopt] [--dry-run]
orca session pull <project> <host> [--as <name>] [--checkout <dir here>]   [--adopt] [--dry-run]
orca session export <project> <file> [--force] [--dry-run]       offline
orca session import <file> [--as <name>] [--checkout <dir>] [--adopt] [--dry-run]
orca session recover                            settle an import that was interrupted
orca session send <project> | receive           internal stdin/stdout endpoints that push/pull run over ssh
```

`<project>` is a **session id, a display name or a folder id, in that order** (`/rename` names are what you normally
type). An ambiguous display name is refused, never guessed. ssh runs with `BatchMode=yes`, `ConnectTimeout=15`,
keepalives and a 30-minute ceiling; the host is passed after `--`, a host starting with `-` is refused, and every
remote argument is single-quoted. The remote binary is `orca` on the non-interactive ssh PATH (`ORCA_REMOTE_COMMAND`
overrides it). Both machines need a build with `orca session`.

## What this does and does not preserve (read this)

- **orca has no provider-side session.** Requests are stateless (`store:false`, no `previous_response_id`): a
  conversation "resumes" by re-sending the stored chain (`Transcript.chain()`). A transfer therefore moves the
  *logical* conversation, byte for byte, and the destination continues from it. It cannot move provider state, because
  there is none.
- **The prompt cache is not transferred.** The first request after a move is a cache miss.
- **The destination can behave differently.** System prompt, config.toml (never copied), model access and the
  context window can differ. The manifest carries the effective model and its settings, which are applied; import
  validates the model name and context-window fit and warns about config keys that differ (compaction threshold,
  tool limits, ...).
- **Thinking blocks / Codex encrypted reasoning across different Claude/Codex accounts is UNVERIFIED.** It is carried
  verbatim and **untested** against the providers; do not assume an identical continuation across accounts.
  Nothing here calls a provider, and an imported project never resumes a model session by itself.
- **Transcripts can contain secrets** pasted into the conversation, and **absolute paths of the sending machine**
  (tool calls and results quote them). They travel exactly as stored, unencrypted inside the bundle (ssh encrypts the
  link; an exported file is created `0600` and not overwritten without `--force`). Rewriting them would change the
  conversation, so it is not done. Review before moving to a machine you do not control.
- The credential scan is by **path name** only (`auth/`, `config.toml`, keys, ...), not by content.

## Identity

Each project has a stable **sessionId** (`projects/<id>/session.json`, minted lazily at first export, also used as the
image-reference scope). It travels in the bundle and identifies "the same project" across machines. `/rename` only
rewrites the name; the sessionId never changes, so renaming on one machine never forks identity. Resolution on the
receiver: sessionId, then display name. A same-name project that **has no session id** is not assumed to be the same
one: pass `--adopt` to merge into it (it then takes the incoming id) or `--as` for a copy. A same-name project with a
*different* session id is a collision: refused (`--as <other name>` imports a separate copy). The sender's display
name is applied unless it collides with another project on the receiver, in which case the receiver's name stays.

`--as <name>` imports the incoming side as a new, separate project: fresh folder id, **new sessionId** (so the copy
and the original can never be mistaken for each other; the source id is recorded as `forkedFrom`), image references
re-scoped to the new id. It is non-lossy and works when the two sides have diverged.

## Conflict rule: structural, never by clock

Every transcript is compared as a line ledger `[(uuid, sha256(line))]` in file order (a transcript's head is its last
line, so lines are never union-merged). Per transcript (orchestrator, each worker, each reviewer; they are
independent):

| relation | result |
|---|---|
| equal | no-op |
| destination is a strict prefix of the source | fast-forward (the newer side wins, zero loss) |
| source is a strict prefix of the destination | destination is newer; kept, reported |
| neither | **DIVERGED: the whole transfer is refused** and nothing is written; the report gives, per side, the common prefix length and the entries only there (last timestamp shown as information only) |

There is **no** `--on-diverge`, no timestamp-based winner and no auto-merge. Pick a side (move one side aside with
`--as`) or keep them as separate projects.

- **tasks.json**: per task id, union. The same task: if one side's history (events, `revision == history.length`) is a
  strict prefix of the other, take the longer; histories that differ otherwise are a conflict and refuse. An archived
  (merged) task is terminal and wins.
- **questions**: union by id; status is monotone (open → answered | skipped; closed beats open); the same id closed
  differently is a conflict and refuses.
- **images**: union by id, sha256 verified; one id with different bytes refuses.
- **Orchestrator unit** (orchestrator transcript + tasks + questions + model, model settings, role models, facts,
  working context): must come from one side wholesale, i.e. every entity either equal or moving in the *same*
  direction; mixed directions refuse. Per-model settings are merged per model. Workers and reviewers are independent.

## What travels (allowlist)

Transcripts (`transcripts/*.jsonl`, including compaction checkpoints and summaries, which are entries), `tasks.json`,
questions, `images/` and `image-inputs/`, and `state.json`: the display name, effective model, `model-settings`,
`role-models`, `facts`, `working-context`, `human-sources`. Never: `auth/`, accounts and provider models,
`config.toml`, `login-url.txt`, `memory.sqlite*` (rebuilt), `launches/`, `runs/`, `*.exit`, `.launch`/`.cancel`
sidecars, `inbox/` (receipts live in the transcript), `merged/`, `input-epoch`, locks, tmux, tool outputs, input
history, `repository.json` and the `archived-agents` marker. Tool outputs (`--include-tool-outputs` in the original
brief) are **not implemented**. A defensive scan aborts a bundle containing any such path on both ends.

## Checkout binding

Absolute paths are never transferred. A new project requires `--checkout <dir>` (the receiving machine's clone); import
verifies its origin matches the manifest (credentials in the origin URL are stripped at export and a bundle carrying
any is refused) and the default branch, and writes a fresh `repository.json` with a new worktreeId. Without a
checkout, import refuses. An existing project keeps its checkout. Legacy clone-based projects (`repo/` inside the
project folder) are refused at export and as a destination. Directory (non-git) projects are supported.

## Safety checks

- **Export** takes the project state lock and the project's turn locks and refuses while any agent is live or liveness
  is unknown (tmux cannot be asked), a run record says running with a live pid, or any agent inbox is non-empty.
  **Import** refuses the same way for an existing destination. Machine-wide, one import runs at a time
  (`.runtime/session-import.lock`).
- **Versions**: the manifest records orca version, `LAYOUT_VERSION` (3), schema versions (tasks 1, state 1) and the
  manifest version; a receiver refuses anything newer than it understands, and unknown transcript entry types.
- **Integrity**: per transcript the manifest records the ledger digest and the `contextDigest` (sha256 of the exact
  JSON of `transcript.chain()`). Import recomputes both from the staged bytes before publishing; a mismatch aborts.
  Export refuses a chain whose tool calls and results are not paired (`paired(chain())`); the receiver applies the
  same rules to a hand-made bundle. Scope: this proves the bytes and chain are what was exported, not that a provider
  will accept them.
- **Images**: references with the legacy, folder-derived scope (projects from before sessions had an id) are
  **refused at export**, not rewritten (a canonical-form rewrite was judged riskier than a clear message). New
  conversations use sessionId-scoped references, which load byte-identically wherever the project goes.
- Unfinished tasks (runs `prepared`/`started`) import as **stopped** runs with attention `unknown`, reason
  "interrupted by session transfer", and one history event. Nothing restarts, no agent launches, no queue is consumed,
  no provider is called.

## Publication, backup and recovery

Not one filesystem transaction; **recoverable**. An import stages and verifies everything in `sync-staging/<id>/`
(state root, same filesystem), writes `journal.json`, then: copies each replaced file to
`sync-backup/<project>/<time>-<id>/` (never inside the project, so the TUI never lists it) and renames the staged file
over it; writes the state keys; moves the journal to *committing* (the commit point); merges tasks in one SQLite ledger
transaction (applied last: the ledger forbids regression, so it cannot be undone, but it is atomic and idempotent); and
writes the sync ledger (`session.json`: peer and agreed ledger heads) last. A failure before the commit point rolls
back (restore by copy + rename; a newly created project is removed). If a rollback itself fails, the error names the
backup and journal and the journal is kept. A crash leaves the journal: every import and `orca session recover` roll it
back (phase *applying*) or complete it (*committing*), and export and import refuse a project with an unsettled
journal. `sync-backup/` and finished staging are **kept, not pruned**; delete them when satisfied.

## Not run / not verified

- Nothing was exercised against a real ssh peer or a real provider; ssh is an injected boundary in tests, which run
  whole transfers in-process.
- Cross-account reasoning replay (above) and prompt-cache behavior are unverified.
