import { promptDefinitions } from "../definitions";
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
export const DYNAMIC_DISPATCH = `For requested publication, plan coherent independently reviewable changes and genuine prerequisites. Parallelize independent work with explicit file ownership. Reuse the current unmerged branch for feedback; after merge use a linked follow-up. Respect the user's requested PR count. Prefer low merge depth and shared contracts. Dependency checkpoints permit early local development, while existing publication gates wait for verified prerequisite merges. This publication guidance does not require ordinary work to create tasks, commits, reviews or PRs.`;

/** Limits apply only when publication/review was requested. */
const taskFlow = (rounds: number) => rounds === 0
  ? "For requested publication: 0 review rounds; use watch-ci with existing check evidence when allowed by dependency gates."
  : `For requested publication: At most ${rounds} review ${rounds === 1 ? "round" : "rounds"}; stop and report unresolved findings at the limit. Review is optional for ordinary work.`;

const TERMINOLOGY = "Use the user’s terminology for concepts and features. If an internal term differs, explain the distinction rather than silently substituting it.";

const templates: Record<Role, string> = { orchestrator: ORCHESTRATOR, worker: WORKER, reviewer: REVIEWER };

/** What a prompt needs: config.toml's thresholds plus the project's resolved task-flow settings (`effectiveFlow`). */
export type PromptConfig = Pick<Config, "maxReviewRounds" | "dynamicDispatch" | "cyclomatic" | "cognitive">;

/** The prompt for a role with its values filled in; callers resolve the project's review rounds and dispatch first. */
export function rolePrompt(role: Role, config: PromptConfig): string {
  const values: Record<string, string | number> = { taskFlow: taskFlow(config.maxReviewRounds), cyclomatic: config.cyclomatic, cognitive: config.cognitive };
  const prompt = `${promptDefinitions(role, templates[role], TERMINOLOGY)}${templates[role]}\n\n${role === "orchestrator" ? taskFlow(config.maxReviewRounds) : ""}\n\n${TERMINOLOGY}`.replace(/\{(\w+)\}/g, (m, key: string) => (key in values ? String(values[key]) : m));
  return role === "orchestrator" && config.dynamicDispatch ? `${prompt}\n\n${DYNAMIC_DISPATCH}` : prompt;
}
