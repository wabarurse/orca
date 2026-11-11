import type { Task } from "../../protocol/task";

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
    reviewActivity: known("reviewActivity"), mergeable: known("mergeable") };
}
