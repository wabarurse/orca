// /review-rounds and /dynamic-dispatch: the project's task-flow settings.

import { validRounds, MAX_REVIEW_ROUNDS } from "../../config/config";
import { projectIdentity } from "../../core/data/projects/state";
import { effectiveFlow, saveProjectFlow } from "../../core/data/projects/flow";

export const REVIEW_ROUNDS_USAGE = `usage: /review-rounds [n]  (n = 0 to ${MAX_REVIEW_ROUNDS}; 0 skips review and goes straight to ci)`;

/** `/review-rounds [n]`: show the project's review round limit, or save it for this project. */
export async function reviewRounds(project: string, arg: string): Promise<string> {
  const identity = projectIdentity(project);
  if (!arg) return `review rounds: ${(await effectiveFlow(project)).maxReviewRounds}`;
  const n = /^\d{1,3}$/.test(arg) ? Number(arg) : NaN;
  if (!validRounds(n)) return REVIEW_ROUNDS_USAGE;
  await saveProjectFlow(project, { maxReviewRounds: n }, identity);
  return `review rounds set to ${n} for this project; applies from the orchestrator's next turn`;
}

export const DYNAMIC_DISPATCH_USAGE = "usage: /dynamic-dispatch [on|off]";

/** `/dynamic-dispatch [on|off]`: show the project's switch, or save it for this project. */
export async function dynamicDispatch(project: string, arg: string): Promise<string> {
  const identity = projectIdentity(project);
  if (!arg) return `dynamic dispatch: ${(await effectiveFlow(project)).dynamicDispatch ? "on" : "off"}`;
  if (arg !== "on" && arg !== "off") return DYNAMIC_DISPATCH_USAGE;
  await saveProjectFlow(project, { dynamicDispatch: arg === "on" }, identity);
  return `dynamic dispatch set to ${arg} for this project; applies from the orchestrator's next turn`;
}

