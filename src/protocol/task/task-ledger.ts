/** Canonical user record shared by the SQL authority and JSON projection.
 * `number` is project-local; `id` is the global UUID used by dependency references.
 * Project/repository binding and operational metadata are deliberately not user fields.
 */
export const ledgerTaskStatuses = ["queued", "building", "pr open", "merged"] as const;
export type LedgerTaskStatus = typeof ledgerTaskStatuses[number];
export interface LedgerTask {
  readonly id: string;
  readonly number: number;
  title: string;
  summary: string;
  createdAt: string;
  /** First evidenced reach only; absent means unknown, never migration time.
   * buildingAt: earliest confirmed run start; prOpenAt: verified OPEN observation.
   * mergedAt: provider merge time (not local observation/archive time).
   */
  checkpoints: { queuedAt?: string; buildingAt?: string; prOpenAt?: string; mergedAt?: string };
  status: LedgerTaskStatus;
  dependencies: string[];
  prLink?: string;
}

/** Private envelope, never additional user statuses. Preserve the complete legacy
 * Task here on import, including ownership, branch, runs, readiness and history.
 * Separate merge observation time from the public provider merge checkpoint.
 */
export interface LedgerTaskSafety {
  legacy?: import("./tasks").Task;
  ownership?: { agent: string; run: string };
  readiness?: import("./tasks").TaskReadiness;
  attempts?: import("./tasks").TaskRun[];
  history?: import("./tasks").TaskEvent[];
  mergeObservedAt?: string;
}

/** Public checkpoints do not depend on review/CI readiness. The private legacy
 * lifecycle remains unchanged for dispatch and merge safety. */
export function canonicalTask(task: import("./tasks").Task): LedgerTask {
  const checkpoints = { ...task.checkpoints };
  const starts = task.runs.flatMap(r => r.startedAt ? [r.startedAt] : []).sort();
  if (!checkpoints.queuedAt && task.history[0]?.kind === "registered") checkpoints.queuedAt = task.createdAt;
  if (!checkpoints.buildingAt && starts[0]) checkpoints.buildingAt = starts[0];
  if (!checkpoints.prOpenAt && task.publication?.state === "OPEN") checkpoints.prOpenAt = task.publication.observedAt;
  if (!checkpoints.mergedAt && task.archive) checkpoints.mergedAt = task.archive.mergedAt;
  return { id: task.id, number: task.number ?? 0, title: task.name, summary: task.summary,
    createdAt: task.createdAt, checkpoints,
    status: task.archive ? "merged" : checkpoints.prOpenAt ? "pr open" : checkpoints.buildingAt ? "building" : "queued",
    dependencies: task.dependsOn ?? [], ...(task.pr ? { prLink: task.pr.url } : {}) };
}

export function publicTaskStatus(task: Pick<import("./tasks").Task, "archive" | "checkpoints" | "publication">): LedgerTaskStatus {
  return task.archive ? "merged" : task.checkpoints?.prOpenAt || task.publication?.state === "OPEN" ? "pr open" : task.checkpoints?.buildingAt ? "building" : "queued";
}
