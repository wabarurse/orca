# Bubbles evaluation (2026-11-16/17)

Does an orchestrator that joins a bubble get up to speed faster than a fresh one, and does it
do the work the way the user already decided? Four arms on two real tasks, plus an earlier
question-answering round. Every run used the same model and effort (claude-opus-5-5, xhigh),
one run per arm. Raw records (prompts, transcripts, answers, diffs, per-run metrics) are kept
locally and are not committed, because they contain a private repository's code.

## Setup

- **Memory.** Built once from a 19-day, 72 MB orchestrator transcript of a private project:
  the readable text (4.7 MB) was cut just before the questions used for the first round, a
  small model extracted facts per chunk, and five passes assembled them into 139 nodes
  (476 KB). It was imported into a bubble with `writeNode`.
- **Orca arms.** New conversations in the project's folder, run by this branch's build. The
  "with bubble" conversations were attached to the imported bubble; the "fresh" ones were not.
  A fresh orca conversation is not blank: it still has orca's `history` tool, which searches
  earlier conversations' archives, and it used it.
- **Claude Code arms.** Subagents with the same prompt. The "with bubble" agents were pointed
  at the bubble's `memory/INDEX.md` and read node files directly.
- **Measured.** Wall time from the prompt to the final reply; tool calls by name from the
  transcripts (workers included); for orca, model calls and tokens from `usage.jsonl`.
  Claude Code token totals are not listed: its log does not give a per-request figure that
  compares with orca's.

## Task 1: write a worker brief for an open PR (read-only)

Graded on four things the user had settled or left open: the exact behaviour wanted, the
decision still open, what to verify, and the working rules (paid evals, feature flags,
merging, production data). All four briefs covered all four.

| Arm | Time | Tool calls | Of which | Model calls | Input tokens (cached) |
| --- | --- | --- | --- | --- | --- |
| Orca, fresh | 189 s | 33 | history 23, bash 6 | 15 | 751k (689k) |
| Orca, with bubble | 151 s | 10 | memory 3, bash 7 | 8 | 335k (298k) |
| Claude Code, fresh | 549 s | 61 | bash 47, read 15 | | |
| Claude Code, with bubble | 241 s | 21 | bash 16, read 4 (6 calls on memory files) | | |

## Task 2: re-implement a real merged change from its parent commit (code, local only)

Each arm worked on its own local branch and worktree, with no pushes. Graded against the
real change on five points: the element name it added, no new stored field (the real change
avoided one because older workers reject unknown fields during a deploy), a first note lists
every such tag, a tag going from ticked to No shows both changes, and the prompt names the
new element. All four passed their own scoped tests.

| Arm | Time | Tool calls | Model calls | Input tokens (cached) | Matches the real design |
| --- | --- | --- | --- | --- | --- |
| Orca, fresh | 1240 s | 177 (orchestrator 63, worker 114) | 128 | 13.3M (12.7M) | 3 of 5: added a new stored field, different element name |
| Orca, with bubble | 594 s | 79 (memory 5) | 68 | 8.4M (8.2M) | 5 of 5 |
| Claude Code, fresh | 1208 s | 109 | | | 4 of 5: different element name |
| Claude Code, with bubble | 903 s | 90 (4 on memory files) | | | 5 of 5 |

The fresh orca run chose the design the user had rejected (a new stored field, with the
deploy risk it carries) and said so in its report. Both bubble runs avoided it and gave the
reason from memory.

## Earlier round: 22 questions about the project

Same memory, read as files; graded against the user's answer key.

| Arm | Session questions (10) | General questions (12) |
| --- | --- | --- |
| Orca, fresh | 132 s, 17 calls, about 10 | 252 s, 46 calls, about 11.5 |
| Orca, with bubble | 79 s, 11 calls, about 10 | 80 s, 16 calls, about 12 |
| Claude Code, fresh | 143 s, 18 calls, about 10 | 362 s, 62 calls, about 11.5 |
| Claude Code, with bubble | 117 s, 12 calls, about 9.5 | 107 s, 14 calls, about 12 |

## What the runs showed about the feature itself

- The `bubble`, `bubble-orcs` and `bubble-hits` sections reached the attached conversations
  on their first request; the matches for the coding prompt led with the right node.
- The background pass ran for the fresh coding conversation (two calls on the small model,
  9.3k input tokens in total) and wrote two nodes: what the code did at the base commit, and
  the state of the local branch.
- Deleting the last conversation of each test bubble removed the bubble's files.

## Limits

- One run per arm. The eight task runs overlapped in time on one machine, so wall times
  include contention.
- Graded by the author of the change, against checklists written before the runs were read.
- The memory was built from the same conversation that produced the real change in Task 2,
  so it described that change's outcome (not its code). That is what a bubble would hold in
  practice, but it means Task 2 measures "does it follow what was decided", not discovery.
- The memory was imported, not accumulated turn by turn. The cost and quality of the
  per-turn pass over a long project are not measured here.
- A detailed PR description is already a kind of memory: the fresh arms found most of what
  they needed on GitHub, only more slowly.
