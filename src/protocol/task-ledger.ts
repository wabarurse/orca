/** Dormant canonical user record shared by the future SQL authority and JSON projection.
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
  references: string[];
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
