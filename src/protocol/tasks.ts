// Task records as the Tasks inbox panel shows them (core/data/tasks/tasks.ts
// stores and transitions them) and `taskPR`, the pure parser of a PR snapshot.

export const taskStatuses = ["queued", "working", "reviewing", "ready_to_merge"] as const;
export type TaskStatus = typeof taskStatuses[number];
export const taskStatusLabels: Record<TaskStatus, string> = { queued: "queued", working: "working", reviewing: "reviewing", ready_to_merge: "ready to merge" };
export type AttentionKind = "waiting" | "blocked" | "cancelled" | "closed" | "unknown";
export interface TaskAttention { kind: AttentionKind; reason: string }
export interface TaskPR { repository: string; number: number; url: string; head: string }
export interface TaskRun {
  /** Explicit dispatch intent; absent in legacy runs (not safely inferable). */
  reviewMode?: "review" | "watch-ci";
  id: string; agent: string; role: "worker" | "reviewer";
  state: "prepared" | "started" | "stopped" | "failed";
  preparedAt: string; startedAt?: string; endedAt?: string;
}
export interface TaskReadiness { head: string; run: string; validatedAt: string; validation: string; checks: "passed" | "not_configured" }
export interface TaskEvent { revision: number; at: string; kind: string; status: TaskStatus; run?: string; pr?: TaskPR; attention?: TaskAttention; readiness?: TaskReadiness }
export interface Task {
  readonly id: string; name: string; summary: string; branch: string; status: TaskStatus;
  createdAt: string; updatedAt: string; revision: number;
  runs: TaskRun[]; pr?: TaskPR; readiness?: TaskReadiness; attention?: TaskAttention;
  archive?: { reason: "merged"; mergedAt: string; archivedAt: string; pr: TaskPR };
  history: TaskEvent[];
}
/** Small UI projection. No transcripts, prompts, reports or mutable display-name identities. */
export type TaskRow = Pick<Task, "id" | "name" | "summary" | "branch" | "status" | "createdAt" | "updatedAt" | "attention" | "pr"> & { review?: { rounds: number; unknown: boolean; ci: boolean } };
/** taskPR's validators; tasks.ts shares them for the rest of a record. */
export const sha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40,64}$/.test(s);
export const object = (s: unknown): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s);
export function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`tasks: ${message}`); }
export function taskPR(raw: unknown): TaskPR {
  check(object(raw), "invalid pr");
  check(typeof raw.repository === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(raw.repository), "invalid pr repository");
  const repository = raw.repository.toLowerCase();
  check(Number.isSafeInteger(raw.number) && Number(raw.number) > 0, "invalid pr number");
  const number = Number(raw.number), url = `https://github.com/${repository}/pull/${number}`;
  check(typeof raw.url === "string" && raw.url.toLowerCase() === url, "pr url must match its github repository and number");
  check(sha(raw.head), "invalid pr head");
  return { repository, number, url, head: raw.head };
}
/** PR snapshots are obtained from GitHub, not from a report or a guessed branch URL. */
export interface PRObservation {
  pr: TaskPR; branch: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt?: string;
  ready: boolean; checks: "passed" | "not_configured" | "pending" | "failed" | "unknown";
  /** Whether it merges cleanly into its base; "unknown" (or absent) while GitHub has not computed it. */
  mergeable?: "mergeable" | "conflicting" | "unknown";
}
