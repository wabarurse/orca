// The role system prompts (one file per role) with their values filled in:
// short lists of how each agent behaves, after the provider's compatibility
// identity. Thresholds come from config and the review limit / dispatch switch
// from the agent's project (project-flow.ts), so the prompt and the tools agree.

import type { Config } from "../../config";
import type { Role } from "../../protocol";
import { ORCHESTRATOR } from "./orchestrator";
import { REVIEWER } from "./reviewer";
import { WORKER } from "./worker";

// Appended to the orchestrator prompt only when /dynamic-dispatch is on, outside
// the base prompt's budget. Adapted to this app: spawn branches only from the
// default branch, workers don't push (reviewers publish), the UI is a terminal.
export const DYNAMIC_DISPATCH = `## Splitting work into PRs
The PR is the unit of work. Decide the PRs first, then assign one worker per PR. Split by what a reviewer can approve alone, never by layer. Optimize for small, independently mergeable PRs, low merge depth and high safe concurrency, not maximum PR count.
Before dispatch, report the PR count, maximum merge depth, and immediately runnable task numbers. Depth counts levels: the longest prerequisite path in nodes; independent tasks have depth 1. Extend the plan table to: Task # · branch · scope · depends on. The plan table gets one row per PR. Use numbered tasks for dependencies, "none" for roots, and "<branch> (existing)" for reused branches.
Plan a DAG of true prerequisites. Justify every edge with a concrete code, migration or safety prerequisite; a shared subject is not an edge. Spawn only branches from the default branch; only real dependents wait for prerequisites to merge before starting. Independent milestones run in parallel on disjoint files, including build registrations; account for shared-file ownership before dispatch.
Agree shared request/result/error contracts before parallel UI and backend work. Use an existing or agreed contract; if a shared contract PR is necessary, it must merge first. No competing interfaces or empty scaffolding. Contracts do not justify layered PRs that cannot merge alone.
Pick the pattern:
- Data change: expand/contract. Add and dual-write; flip reads; stop writing and tombstone; drop. Preserve genuine migration, deployment and safety gates. Each body names its merge gate ("after PR N's deploy rolls out"). Codeowner-owned migrations get their own PR.
- Planned feature: independently mergeable milestones, not a sequential stack by default. Prefer disabled implementations with tests that can merge independently; apply rollout prerequisites to activation, not automatically to implementation. Keep genuine safety prerequisites even for disabled code.
- Behavior switch: one PR adds it dormant with tests, a second small PR turns it on when rollout gates are satisfied.
- Anything else: one coherent, independently testable behavior. Do not split merely by layer or title wording, or inflate PR count to hit size targets.
Examples: independent disabled UI and backend implementations using an agreed contract can be tasks 1 and 2 (depth 1); activation task 3 depends on 1 and 2 (depth 2). A necessary shared contract PR comes first only when the implementations require its merged code. An expand/contract migration still waits for the required deploy before switching reads or dropping old storage.
Each PR:
- Verb-first title stating the behavior change, with the number when there is one. Never a branch name.
- Target 2 to 5 files, under 300 changed lines, without artificial PR inflation. Over 600 changed lines needs a stated reason.
- Merges alone, leaves main working, carries its own test or eval change.
- Body: who is affected, what changes, what it deliberately does not do, production numbers when they motivated it, pasted terminal output for UI.
Workers:
- One per PR, own worktree and branch. Parallel only on disjoint files, including build registrations. Necessary shared prerequisites ship first; only their dependents wait for them to merge.
- Brief names the files, exact change, relevant checks, pattern, and PR title and body. Workers run only relevant checks once per checked code state; never full suites, baseline comparisons or duplicate tests. Reviewers inspect failed-check output, diff and complexity without running checks. The worker writes the title and body into its commit message so the reviewer's PR uses them.
- Follow each PR until it merges. Review fixes before approval stay on the same branch per the task flow, within the review-round limit.
- Approved = the reviewer reported ready to merge. After that, new review findings, including bot or user review comments, become a follow-up PR, not another commit: register a new task and plan a new branch, started after this PR merges. CI failures go to the worker on the same branch. If the user explicitly asks for the fix on this PR, reuse the branch per spawn.`;

/** The task-flow line: 0 rounds skips review and goes straight to CI. */
const taskFlow = (rounds: number) => rounds === 0
  ? `A task runs as: spawn a worker → it reports → spawn the reviewer with "watch ci" and existing check evidence → it reports ready to merge → tell the user.`
  : `A task runs as: spawn a worker → it reports → spawn a reviewer with check evidence. Feedback: worker fixes, reviewer reviews. At most ${rounds} review ${rounds === 1 ? "round" : "rounds"}; stop and report unresolved findings at the limit. Approved: reviewer with "watch ci" and existing evidence → it reports ready to merge → tell the user.`;

const templates: Record<Role, string> = { orchestrator: ORCHESTRATOR, worker: WORKER, reviewer: REVIEWER };

/** What a prompt needs: config.toml's thresholds plus the project's resolved task-flow settings (`effectiveFlow`). */
export type PromptConfig = Pick<Config, "maxReviewRounds" | "dynamicDispatch" | "cyclomatic" | "cognitive">;

/** The prompt for a role with its values filled in; callers resolve the project's review rounds and dispatch first. */
export function rolePrompt(role: Role, config: PromptConfig): string {
  const values: Record<string, string | number> = { taskFlow: taskFlow(config.maxReviewRounds), cyclomatic: config.cyclomatic, cognitive: config.cognitive };
  const prompt = templates[role].replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
  return role === "orchestrator" && config.dynamicDispatch ? `${prompt}\n\n${DYNAMIC_DISPATCH}` : prompt;
}
