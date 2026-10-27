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
  /** Explicit prerequisite task IDs; absent in legacy records. Not a scheduling signal. */
  dependsOn?: string[];
  runs: TaskRun[]; pr?: TaskPR; readiness?: TaskReadiness; attention?: TaskAttention;
  archive?: { reason: "merged"; mergedAt: string; archivedAt: string; pr: TaskPR };
  history: TaskEvent[];
}
/** Small UI projection. No transcripts, prompts, reports or mutable display-name identities. */
export type TaskRow = Pick<Task, "id" | "name" | "summary" | "branch" | "status" | "createdAt" | "updatedAt" | "attention" | "pr" | "dependsOn"> & { review?: { rounds: number; unknown: boolean; ci: boolean } };
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

/** Dormant tree model, separate from the durable Task and existing inbox rows. */
export type TaskTreeAttention = { kind: "none" } | TaskAttention;
export type TaskTreeState = (
  | { kind: "queued" | "working" | "reviewing" }
  | { kind: "ready_to_merge"; pr: TaskPR; readiness: TaskReadiness }
  | { kind: "merged"; pr: TaskPR; mergedAt: string; archivedAt: string }
) & { attention: TaskTreeAttention };
export type TaskTreeView = Pick<Task, "id" | "name" | "summary" | "branch" | "createdAt" | "updatedAt" | "revision"> & {
  dependsOn: string[];
  state: TaskTreeState;
  /** Detached durable snapshot for details: runs, PR, history, archive and evidence are not discarded. */
  source: Task;
};

/** Local shape only. Cross-registry dangling/cycle checks belong in milestone 2's locked atomic writer. */
export function taskDependencies(raw: unknown, id: string): string[] {
  if (raw === undefined) return [];
  check(Array.isArray(raw), "invalid task dependencies");
  const seen = new Set<string>();
  for (const dep of raw) {
    check(typeof dep === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dep), "invalid dependency id");
    const key = dep.toLowerCase();
    check(key !== id.toLowerCase(), "task cannot depend on itself");
    check(!seen.has(key), "duplicate task dependency"); seen.add(key);
  }
  return [...raw];
}

/** Project validated durable records only; never infer completion from a stopped run or readiness from a PR. */
export function taskTreeView(task: Task): TaskTreeView {
  const source = structuredClone(task);
  const { id, name, summary, branch, createdAt, updatedAt, revision } = source;
  const attention: TaskTreeAttention = source.attention ?? { kind: "none" };
  let state: TaskTreeState;
  if (source.archive) {
    const { pr, mergedAt, archivedAt } = source.archive;
    state = { kind: "merged", pr, mergedAt, archivedAt, attention };
  } else if (source.status === "ready_to_merge") {
    check(source.pr && source.readiness && source.pr.head === source.readiness.head, "ready requires matching validation");
    state = { kind: "ready_to_merge", pr: source.pr, readiness: source.readiness, attention };
  } else state = { kind: source.status, attention };
  return { id, name, summary, branch, createdAt, updatedAt, revision, dependsOn: taskDependencies(source.dependsOn, id), state, source };
}

/** Caller-owned live verification, bound to the task snapshot used for the lookup.
 * PRObservation has no timestamp; callers must drop this evidence when stale or
 * lookup fails. A durable Task.pr (even with readiness) cannot prove OPEN today.
 */
export interface TaskPublicationEvidence {
  taskId: string;
  revision: number;
  observation: PRObservation;
}
export type TaskPublicationMilestone =
  | { kind: "unknown"; tone: "neutral" }
  | { kind: "published"; label: "PR is out"; tone: "green"; pr: TaskPR }
  | { kind: "closed"; label: "PR closed"; tone: "neutral"; pr: TaskPR }
  | { kind: "merged"; label: "merged"; tone: "purple"; pr: TaskPR; mergedAt: string; archivedAt: string };
export interface TaskPublicationView {
  id: string;
  revision: number;
  milestone: TaskPublicationMilestone;
  /** Orthogonal to publication: never hide blocked/cancelled or stopped runs. */
  attention: TaskTreeAttention;
  /** Detached details retain status, readiness, run identities and validation history. */
  source: Task;
}

/** Dormant presentation only: no readiness gate, durable writes or scheduling.
 * Accept only current caller-verified observations matching the associated PR,
 * branch and head. Archive evidence is durable; raw MERGED observations must
 * first go through the existing verified archive writer.
 */
export function taskPublicationView(task: Task, evidence?: TaskPublicationEvidence | null): TaskPublicationView {
  const source = structuredClone(task);
  let milestone: TaskPublicationMilestone = { kind: "unknown", tone: "neutral" };
  if (source.archive) {
    const { pr, mergedAt, archivedAt } = source.archive;
    milestone = { kind: "merged", label: "merged", tone: "purple", pr, mergedAt, archivedAt };
  } else if (evidence?.taskId === source.id && evidence.revision === source.revision) {
    const o = evidence.observation, pr = source.pr;
    if (pr && o.branch === source.branch && o.pr.repository === pr.repository
      && o.pr.number === pr.number && o.pr.url === pr.url && o.pr.head === pr.head) {
      if (o.state === "OPEN") milestone = { kind: "published", label: "PR is out", tone: "green", pr };
      else if (o.state === "CLOSED") milestone = { kind: "closed", label: "PR closed", tone: "neutral", pr };
    }
  }
  return { id: source.id, revision: source.revision, milestone, attention: source.attention ?? { kind: "none" }, source };
}
