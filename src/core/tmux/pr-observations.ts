import type { PRObservation, Task } from "../../protocol/task";

export const activePRTask = (task: Task): boolean => !task.removedAt && !task.archive &&
  task.attention?.kind !== "cancelled" && task.attention?.kind !== "closed" && task.publication?.state !== "CLOSED";

/** Notification history is separate from readiness. An unavailable GitHub field
 * must not erase the last known value and turn its recovery into new activity.
 * A new head starts a new comparison; task validation still gets the raw result. */
export function notificationValue(value: unknown, previous?: unknown): unknown {
  const current = value as Record<string, any>, old = previous as Record<string, any> | undefined;
  const head = current.head ?? current.pr?.head;
  const sameHead = old && head === (old.head ?? old.pr?.head);
  const known = (key: string) => current[key] === undefined || current[key] === "unknown"
    ? (sameHead ? old[key] : undefined) ?? "unknown" : current[key];
  return { state: current.state, head, checks: known("checks"), review: known("review"),
    reviewActivity: known("reviewActivity"), mergeable: known("mergeable"), threads: threadIds(current.threads, sameHead ? old.threads ?? "unknown" : undefined) };
}
/** Unresolved thread ids as one string. A snapshot from before threads were read
 * says "unknown", and finding none after that is not news. */
function threadIds(current: unknown, old: unknown): string {
  if (current === undefined || current === "unknown") return typeof old === "string" ? old : "unknown";
  return current === "" && old === "unknown" ? "unknown" : String(current);
}

/** What stands between an open PR and its merge: `fix` is work an agent can do,
 * `wait` is somebody else's move. Thread and check text never leaves GitHub. */
export function mergeBlockers(o: PRObservation): { fix: string[]; wait: string[] } {
  const fix: string[] = [], wait: string[] = [];
  if (o.mergeable === "conflicting") fix.push("it conflicts with its base branch");
  if (o.checks === "failed") fix.push(`failing checks${o.failing?.length ? `: ${o.failing.join(", ")}` : ""}`);
  if (o.reviewDecision === "CHANGES_REQUESTED") fix.push("a reviewer requested changes");
  if (o.threads?.length) {
    const shown = o.threads.slice(0, 4).map(t => `${t.author} on ${t.path}${t.line ? `:${t.line}` : ""} ${t.url}`);
    fix.push(`${o.threads.length} unresolved review thread${o.threads.length === 1 ? "" : "s"} (${shown.join("; ")}${o.threads.length > shown.length ? "; …" : ""})`);
  }
  if (o.checks === "pending") wait.push("checks still running");
  if (o.reviewDecision === "REVIEW_REQUIRED") wait.push("an approving review");
  if (o.draft) wait.push("it is a draft");
  return { fix, wait };
}
