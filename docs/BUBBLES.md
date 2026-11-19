# Bubbles

A bubble is what a group of orchestrators knows in common. Each orchestrator keeps its own
transcript and context window; the bubble holds what should outlive one conversation and be
shared between several:

| Store | Holds | In an orchestrator's context | Who writes |
| --- | --- | --- | --- |
| Memory | decisions, goals, how things work, expected behaviour, rejected approaches, open questions, PRs | the index (node id and one-line summary); nodes on demand | orchestrators, and a background pass after each turn |
| Notebook | bulky material: tool output, reports, tables | page titles and summaries | orchestrators and workers |
| Behavior | a short list of how the user wants agents to act | all of it | the orchestrator, from the user's own messages only |

A conversation belongs to exactly one bubble (project state key `bubble`). A conversation
that has never written anything has none yet and is listed as a bubble of one. Transcripts,
tasks, agents, questions and images stay with the conversation that owns them; the status
tool shows the open tasks of the other orchestrators in the bubble, by owner.

## Files

Everything is plain files under `~/.orca/bubbles/<bubble-id>/`, so Codex, Claude Code or a
person can read it:

```
bubble.json                      id, name, createdAt
memory/INDEX.md                  every node's id and summary, rewritten on each change
memory/overview.md               what the project is and where it stands
memory/<branch>/<slug>.md        one node
notebook/index.json              the pages, most recently used first
notebook/<page-id>.txt           a live page
notebook/archive/<page-id>.txt   a page pushed out of the cache
behavior.json                    the behavior lines
```

The files are the truth. Search runs over them in process; there is no second index to
rebuild, and no SQLite table.

## Knowledge (the `knowledge` tool; nodes live in `memory/`)

A node has a one-line **summary** that states the fact itself (it is what sits in context)
and dated **entries** that carry the detail (read on demand). A node file:

```
---
id: decisions/flags
title: Feature flags
summary: No feature flags unless the user asks.
keywords: flag, rollout
updated: 2026-11-16T22:10:03.000Z
revision: 3
---
## Current
- User decided: "this is default behavior, no flags". <!-- {"n":1,"at":"…","author":"orch-5xab","sources":["orch-5xab:…"],"retired":null} -->
## Retired (replaced by a later entry; kept as history)
- Flags default off were added to both PRs. <!-- {"n":0,…,"retired":"2026-11-16T22:10:03.000Z"} -->
```

The top level is fixed (`BRANCHES` in `core/data/bubbles/nodes.ts`): goals, decisions,
how-it-works, expected-behavior, tried-and-rejected, open-questions, work-log, plus the
`overview` node. A fixed top level tells every writer where a fact belongs, so two
orchestrators file the same thing in one place. Below it a node id has one to three slugs.

Two kinds of write:

- **Adding an entry** only takes the bubble's memory lock. Order between writers does not matter.
- **Changing a summary, title or keywords, or retiring an entry** also needs the `revision`
  the writer read. A stale revision is refused with the current one, so the writer reads
  again and merges; two orchestrators cannot silently overwrite each other.

A fact that stops being true is **retired**, not deleted and not left beside its replacement:
retired entries leave search and the rendered node, and stay in the file as history. Memory
is not a cache and nothing is evicted from it: its content is small (19 days of one project
was under 500 KB) and is only loaded on demand, so what must stay bounded is the index.
`renderIndex` lists every node while that fits its budget, then shows only the newest nodes
of the busiest branches with a count; `knowledge list <branch>` gives the rest.

Limits (`LIMITS`): title 80 characters, summary 200, entry 700, 12 keywords, 8 sources per
entry, 40 current entries per node (beyond that the writer is told to retire or use a more
specific node).

### How memory is written

1. **The orchestrator**, with `knowledge write`, when the user decides something or a finding
   is established.
2. **A background pass after each turn** (`core/data/memory/bubble-writer.ts`,
   `BubbleWriter`). It reads the transcript entries since its watermark (project state
   `bubble-distilled`, the uuid of the last entry read), turns them into plain lines
   (reference context left out, tool output shortened), shows a small model the memory
   index, the nodes most related to the slice, and the slice, and applies the writes it
   returns. Most turns add nothing. A refused write (bad id, stale revision, over a limit)
   is logged and skipped; the others land. Each written entry records the slice
   (`<conversation>:<first uuid>..<last uuid>`) as its source.

The watermark makes the pass exact: a repeated pass never reads a message twice, and a
failed pass keeps its place and is read again after five minutes. The pass reads original
entries (`Transcript.history()`), so compaction cannot outrun it: what a later compaction
summarises is still on disk for the pass to read. Nothing waits on it; a turn and a
compaction go on while it runs, and its failure only delays memory. It uses the
conversation's account, on the small model unless `smallSummaries = false`, metered as
`bubble-memory`. A slice with nothing said (tool traffic alone) costs no model call.

A conversation that predates the feature starts from its next turn: its history is not
imported automatically.

### How memory is read

- **Before the model runs.** At each request boundary `bubbleContext`
  (`core/data/knowledge/bubble-context.ts`) searches memory with the latest message and
  attaches the best matches as the `bubble-hits` reference section: node id, revision,
  summary, and its best lines. No model call.
- **`knowledge search`** takes up to five phrasings at once and returns, per node, the summary
  and the matching lines, which is often enough without a read.
- **`knowledge read`** takes up to six node ids in one call. **`knowledge list`** lists a branch.

Search (`core/data/bubbles/search.ts`) scores every current entry as its own document with
its node's title, summary and keywords in front of it, and node summaries as documents too,
so one query reaches every level of the tree. Identifiers stay whole words (`#26041`,
`PHO-18782`, `SOME_FLAG`). It is plain text scoring; there are no embeddings.

## Notebook

`notebook put` saves text, or a file from the agent's workspace or evidence folder, with a
title and a summary saying what it holds. `read` returns a line range; `query` returns only
the lines matching a pattern, so a large page is never loaded whole. Workers can write it.

It is a least-recently-used cache: at most 200 live pages and 256 MiB (8 MiB per page). Over
a limit the coldest page moves to `archive/`; its line stays in the list, marked. Reading an
archived page restores it. A page archived for more than 14 days loses its content and its
line: the daemon's maintenance pass does this for its own bubble, and `orca clean` for every
bubble (`orca clean --preview` lists what would go). `orca clean` also removes a bubble no
conversation is attached to.

## Behavior

`remember` with `scope: "bubble"` saves a line. It takes `confidence: "explicit"` only, with
a source that names or quotes a real human message of the conversation, exactly as an
explicit preference does; assistant, tool, worker and web text never qualify. At most 20
lines of 200 characters; a full list takes a new line only in place of an existing key.

## What an agent is shown

`agentContext` adds these reference sections (only a changed section is re-sent, so the
stable part stays in the provider's prompt cache):

- `bubble` — for an orchestrator: the behavior lines, the overview, the memory index and
  the notebook's newest titles. For a worker or reviewer: the behavior lines and the
  overview, with a note that memory and the notebook can be searched.
- `bubble-orcs` — the other orchestrators attached to the bubble and each one's goal.
- `bubble-hits` — the memory matches for the latest message.

A conversation with no bubble, or an empty one of its own, is shown none of them.

## Several orchestrators

A new conversation (Ctrl+N) asks which bubble it joins, in a menu above the composer, as soon as
at least one bubble exists: "New bubble" is selected, so Enter or Esc keeps the conversation on
its own, and any other row attaches it to that bubble. With no bubble on the machine nothing is
asked (`tui/commands/bubble.ts`).

On the work page's Bubbles tab (Ctrl+B), inside a folder, `b` on a conversation starts a new
conversation in the same folder attached to that conversation's bubble; `n` starts one with
a bubble of its own. Members of a shared bubble are listed as `<bubble> ▸ <conversation>`.

Deleting a conversation detaches it; the bubble's files go with its last member.
`/clear-context` keeps the conversation attached: the bubble is what the project knows
beyond one conversation, like saved facts.

## Not done yet

- Tasks, agents, questions and images are still stored with their conversation. The bubble
  level lists them through their owners; it does not move them.
- Automatic archiving of settled tasks, agents, questions and images, and their deletion 14
  days later, is not implemented. Today's manual archive on the work page is unchanged.
- Importing an existing conversation's history into memory is a one-off script, not a command.
- Meaning-based search. Plain text search with identifiers was enough in the evaluation.
