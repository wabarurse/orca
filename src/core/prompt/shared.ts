// The role system prompts (one file per role) with their values filled in:
// short lists of how each agent behaves, after the provider's compatibility
// identity. Thresholds come from config and the review limit / dispatch switch
// from the agent's project (project-flow.ts), so the prompt and the tools agree.

import type { Config } from "../../config/config";
import type { Role } from "../../protocol/transcript";
import { ORCHESTRATOR } from "./orchestrator";
import { REVIEWER } from "./reviewer";
import { WORKER } from "./worker";

// Appended to the orchestrator prompt only when /dynamic-dispatch is on, outside
// the base prompt's budget. Adapted to this app: spawn branches only from the
// default branch, workers don't push (reviewers publish), the UI is a terminal.
export const DYNAMIC_DISPATCH = `## Splitting work into PRs
The PR is the unit of work. Decide the PRs first, then assign one worker per PR. Split by what a reviewer can approve alone, never by layer. The plan table gets one row per PR.
Pick the pattern:
- Data change: expand/contract. Add and dual-write; flip reads; stop writing and tombstone; drop. Each body names its merge gate ("after PR N's deploy rolls out"). Codeowner-owned migrations get their own PR.
- Planned feature: one PR per milestone, titled \`<feature> 2/5: <milestone>\`. Spawn only branches from the default branch, so dispatch the stack sequentially: each PR starts after the previous one merges. Bottom layers change no behavior. Every body lists the stack and marks the current PR.
- Behavior switch: one PR adds it dormant with tests, a second small PR turns it on.
- Anything else: one flag, one function, one fix, one endpoint. If the title needs "and", split.
Each PR:
- Verb-first title stating the behavior change, with the number when there is one. Never a branch name.
- 2 to 5 files, under 300 lines. Over 600 lines needs a stated reason.
- Merges alone, leaves main working, carries its own test or eval change.
- Body: who is affected, what changes, what it deliberately does not do, production numbers when they motivated it, pasted terminal output for UI.
Workers:
- One per PR, own worktree and branch. Parallel only on disjoint files; shared prerequisites ship first as their own PR, dependents start when it merges.
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
