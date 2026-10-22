# Production efficiency comparison

## Scope and source

The production branch implements exactly the three selected experiments: Claude
prompt-prefix caching; saved Bash output with bounded, adjustable previews; and
parallel execution of explicitly independent calls. It adds usage measurements
for evaluation. It does not add a hashmap/vector store, native file tools, or a
background compaction worker.

Baseline: `50a5ef9`, archived without edits. Updated production implementation:
`4bc0b6f`; the direct-repair runner correction is `8e01180`. Production code stayed
unchanged throughout both matrices.
Both use the same installed dependency lockfile. `bootstrap.ts` freezes the old
source outside the repository; `results/paths.json` records the snapshot location.

Unlike the earlier minimal-agent experiment, Parallels runs its production
`createOrchestrator`, role instructions, tool schemas, inbox delivery and transcript
implementation. The benchmark is headless and single-agent: delegation, task
registration, questions, network access and installs are disabled for all arms.
The orchestrator role still prescribes its worker/reviewer workflow, which can
conflict with direct repairs in this single-agent setup. Such refusals count as
failures and are not evidence about the efficiency features. The Parallels
registry retains its production schemas, but its execution wrapper
allows only Bash and messages to the user. This does not benchmark the TUI,
reviewer loop, worktree lifecycle or long-session compaction.

## Matrix and isolation

The primary matrix has five tasks × three repeats × six arms = 90 trials.
There are 108 retained live trials in total: the original 90 plus a complete
18-trial direct-repair block (see the correction below).

- Parallels before/after with `gpt-6-astra`, compared with Codex CLI 0.154.0.
- Parallels before/after with `claude-opus-5-5`, compared with Claude Code 2.1.307.
- Medium effort, fast mode off; existing subscriptions, no platform API keys.

Each trial receives a new generated repository and disposable project settings.
Saved logs, credentials and benchmark artifacts cannot pollute repository searches.
Parallels credentials are resolved from the existing account; the runner restores
the real authentication root only while the provider completes a request, then
restores isolated project state before tools run. No credential files are copied.

Runs are sequential. Arm order rotates by task and reverses on alternate repeats.
All prompts ask for direct local work, concise results and concurrent independent
reads. Native product role prompts and tool schemas are retained, so CLI
comparisons are matched workloads, not identical model-request experiments.
Codex uses its workspace-write sandbox; permissions/sandbox implementation cannot
be made identical across products. CLI user configuration, MCP, plugins, hooks,
automatic memory, discovery and external tools are disabled where supported;
exact commands and environment versions are retained locally.

Fresh processes do not mean cold provider caches. Shared prefixes may already be
warm, including from smoke tests and earlier trials. We cannot flush provider
caches. Subscription/backend queue time, CLI startup, model sampling and harness
transport contribute to wall time. Account-level service differences are not
controlled, particularly between the Claude subscription clients.

## Repair workflow correction

The original repair task conflicted with the orchestrator's required delegation
workflow: two before-GPT trials and one after-GPT trial identified the code fix but
refused direct changes. This is an evaluation setup limitation, not a correctness
gain from caching, saved output or parallel tools.

All 18 original repair trials remain in `live.jsonl` and `live.audited.jsonl`,
including successes. The entire repair block was then rerun for **all six arms**,
with the same fixtures, seeds and graders. `EFF_DIRECT=1` appends an explicit
benchmark-only system/developer instruction authorizing direct local work and
superseding the usual delegation/branch/approval/commit workflow. For Parallels it
is appended at the measured provider boundary; for the CLIs it is appended to
the same system/developer benchmark instructions. No production prompt changed.

`primary.audited.jsonl` contains the original 72 non-repair trials plus all 18
corrected direct repairs. This is a workflow-normalized single-agent comparison,
not an unmodified end-to-end orchestration benchmark. The original 90-trial
summary is also published. No individual failed or slow trial was selectively
replaced; the original non-repair timeout remains in the primary comparison.
The repair rerun happened later, with potentially warmer caches and different
service conditions, so small timing differences should not be generalized.

## Tasks and grading

| Task | Work | Independent check |
|---|---|---|
| Lookup | Find three service timeout values in 24 generated source files | Seeded expected JSON; no file changes |
| Repair | Fix an off-by-one array-window function and run tests | Original tests untouched, exhaustive 800 windows plus negative-input checks; test execution observed |
| Repository | Inspect four real Parallels source files for six implementation limits | Exact expected values; no file changes |
| Output | Run a 2,400-line diagnostic and recover its middle fault | Exact fault code/path, observed diagnostic execution; no file changes |
| Parallel | Run four separate read-only health probes, each with a two-second wait | Four separate command calls, expected statuses; no file changes |

The parallel task deliberately measures controlled I/O waiting; it is reported
separately from the four coding/inspection tasks. These are small, deterministic
local tasks, not a large real-project coding benchmark. There are only three
samples per task and arm. Means, medians, per-task results, all failures and raw
observations are retained; no run is removed because it was slow.

Each process has a 210-second cap; Parallels also cancels its controller after
180 seconds and caps model requests at 30. Failures before any tool execution
halt the runner for investigation. Two pre-matrix smoke tests failed on evaluation
credential-path isolation, before inference. Their records are retained in
`smoke.jsonl` and `smoke2.jsonl`; `smoke3.jsonl` verifies the fix. They are not part
of the 90-trial outcome matrix.

## Measurements

- **Elapsed time:** process start through exit, including CLI startup, model calls,
  tool execution and transcript persistence. Post-run grading is excluded.
- **Total input tokens:** sum of provider-reported input across requests, including
  cache reads and writes. This measures cumulative context traffic, not peak
  context and not unique source content.
- **Uncached input:** total input minus cache reads. Cache writes are included and
  separately reported. This is not a dollar-cost estimate or an exact amount of
  provider computation.
- **Cache reuse:** total cache-read input divided by total input, weighted across
  requests. Caching does not reduce occupied context.
- **Peak input:** largest observed single-request input where exposed. Codex exec
  JSON provides aggregate turn usage, so its peak is unavailable, not zero.
- **Output tokens:** provider total. Reasoning tokens are reported only when
  exposed; missing metrics remain null.
- **Tools:** observed executions; Parallels includes its message tool. Call counts
  are therefore descriptive, not directly equivalent across products.

Both Parallels arms use the same instrumented subscription adapter to obtain
usage. Claude cache control is explicitly off before and on after. With it off,
the baseline request payload is unchanged. The old OpenAI adapter did not supply
observed input to budget planning, so the before wrapper removes that observation;
it retains the old controller's budgeting behavior. The updated adapter exposes
full input (including cached input), preventing cache hits from being mistaken for
free context. The archived controller, prompts, tool definitions and execution
remain the before source.

`audit.ts` re-reads saved final answers, CLI event streams, Parallels provider
responses, commands, transcripts and workspace files. It reconstructs token totals,
checks required actions, reruns the independent correctness oracle and verifies
file scope. It writes a separate audited JSONL; raw observations remain unchanged.
Full prompts/responses/transcripts stay in the local artifact directory; only
numeric summaries, command evidence and methodology enter Git.

## Reproduce

From this worktree with Bun and both authenticated CLIs installed:

```sh
bun install --frozen-lockfile
bun evals/efficiency/bootstrap.ts
EFF_RESULTS=evals/efficiency/results/new-run.jsonl bun evals/efficiency/run.ts
bun evals/efficiency/audit.ts evals/efficiency/results/new-run.jsonl
bun evals/efficiency/summarize.ts evals/efficiency/results/new-run.audited.jsonl
EFF_DIRECT=1 EFF_TASKS=repair EFF_RESULTS=evals/efficiency/results/new-repairs.jsonl bun evals/efficiency/run.ts
bun evals/efficiency/audit.ts evals/efficiency/results/new-repairs.jsonl
```

`EFF_ARMS`, `EFF_TASKS`, `EFF_DIRECT`, and `EFF_REPEATS` can select a smoke subset. Result files
are never overwritten by the runner. Bootstrapping requires the baseline and
fixture snapshot commits to exist locally. Raw artifact locations in committed
JSON are specific to the machine that ran the study.

The command interfaces follow the official [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude Code headless documentation](https://code.claude.com/docs/en/headless).
Grading follows the separation of process evidence and outcome checks described
in OpenAI's [evaluation guidance](https://developers.openai.com/blog/eval-skills).
Local CLI help was checked for the installed versions; `claude --bare` was not
used because that mode disables subscription OAuth in this installation.
