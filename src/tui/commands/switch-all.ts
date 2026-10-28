// The "switch all" confirmation /model, /effort and /fast share: every running
// agent reads the project's model and settings before its next model request.

import type { Choice } from "./model";

/** The confirmation for `question` over the live agent windows, or null when no worker or reviewer runs (save at once). */
export function switchAllMenu(question: string, agents: string[]): { title: string; choices: Choice<boolean>[] } | null {
  const workers = agents.filter((name) => name.startsWith("worker-")).length;
  const reviewers = agents.filter((name) => name.startsWith("reviewer-")).length;
  if (!workers && !reviewers) return null;
  return {
    title: `${question} applies to orchestrator, ${workers} workers and ${reviewers} reviewers. running tools finish; agents switch before their next model request.`,
    choices: [{ value: false, label: "cancel", current: true }, { value: true, label: "switch all" }],
  };
}
