// The "switch all" confirmation /model, /effort and /fast share: every running
// agent reads the project's model and settings before its next model request.
// With a scope (/model for one role) it counts only that role's running agents.

import type { Choice } from "./model";
import { scopeNames, type Scope } from "./scope";

/** The confirmation for `question` over the live agent windows, or null when nothing it applies to runs besides the orchestrator
 * (save at once). "all" counts workers and reviewers; a role counts only its own windows; the orchestrator scope never asks,
 * as a change while only the orchestrator runs never did. */
export function switchAllMenu(question: string, agents: string[], scope: Scope = "all"): { title: string; choices: Choice<boolean>[] } | null {
  const workers = agents.filter((name) => name.startsWith("worker-")).length;
  const reviewers = agents.filter((name) => name.startsWith("reviewer-")).length;
  const cancel: Choice<boolean> = { value: false, label: "cancel", current: true };
  if (scope === "all") {
    if (!workers && !reviewers) return null;
    return {
      title: `${question} applies to orchestrator, ${workers} workers and ${reviewers} reviewers. running tools finish; agents switch before their next model request.`,
      choices: [cancel, { value: true, label: "switch all" }],
    };
  }
  const running = scope === "worker" ? workers : scope === "reviewer" ? reviewers : 0;
  if (!running) return null;
  return {
    title: `${question} applies to ${running} running ${scopeNames[scope]}. running tools finish; they switch before their next model request.`,
    choices: [cancel, { value: true, label: `switch ${scopeNames[scope]}` }],
  };
}
