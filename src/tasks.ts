// Structured task records, not a scheduler or any of the message/question queues.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { paths } from "./config";
import { assertProjectIdentity, projectIdentity, withProjectStateLock } from "./project-state";
import { clean } from "./questions";

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
interface Store { version: 1; tasks: Task[] }
const file = (project: string) => `${paths.project(project)}/tasks.json`;
const uuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const stamp = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s));
const sha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40,64}$/.test(s);
const object = (s: unknown): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s);
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`tasks: ${message}`); }
function text(value: unknown, max: number, what: string): string {
  check(typeof value === "string", `${what} must be text`);
  const s = clean(value, max, what); check(s, `${what} is required`); return s;
}
function projectId(project: string): void { check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project), "invalid project id"); }
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
function attention(raw: unknown): TaskAttention {
  check(object(raw) && ["waiting", "blocked", "cancelled", "closed", "unknown"].includes(String(raw.kind)), "invalid attention");
  return { kind: raw.kind as AttentionKind, reason: text(raw.reason, 500, "attention reason") };
}
function validateReadiness(raw: unknown): asserts raw is TaskReadiness {
  check(object(raw) && sha(raw.head) && stamp(raw.validatedAt) && typeof raw.run === "string" && /^[\w-]{1,100}$/.test(raw.run) && ["passed", "not_configured"].includes(String(raw.checks)), "invalid readiness");
  check(text(raw.validation, 2000, "validation") === raw.validation, "noncanonical validation");
}
function validateTask(raw: unknown): asserts raw is Task {
  check(object(raw) && uuid(raw.id), "invalid task id");
  check(text(raw.name, 120, "name") === raw.name && text(raw.summary, 500, "summary") === raw.summary && text(raw.branch, 250, "branch") === raw.branch, "noncanonical text");
  check(taskStatuses.includes(raw.status as TaskStatus), "invalid status");
  check(stamp(raw.createdAt) && stamp(raw.updatedAt) && Number.isSafeInteger(raw.revision) && Number(raw.revision) > 0, "invalid task timestamps/revision");
  check(Array.isArray(raw.runs) && Array.isArray(raw.history), "invalid task history");
  const seen = new Set<string>();
  for (const r of raw.runs) {
    check(object(r) && typeof r.id === "string" && /^[\w-]{1,100}$/.test(r.id) && !seen.has(r.id), "invalid/duplicate run");
    seen.add(r.id);
    check(typeof r.agent === "string" && /^[\w.-]+$/.test(r.agent) && ["worker", "reviewer"].includes(String(r.role)), "invalid run agent");
    check(["prepared", "started", "stopped", "failed"].includes(String(r.state)) && stamp(r.preparedAt), "invalid run state");
    check(r.reviewMode === undefined || (r.role === "reviewer" && ["review", "watch-ci"].includes(String(r.reviewMode))), "invalid review mode");
    check(r.startedAt === undefined || stamp(r.startedAt), "invalid start time");
    check(r.endedAt === undefined || stamp(r.endedAt), "invalid end time");
    check((r.state === "prepared" || r.state === "failed") ? r.startedAt === undefined : r.state !== "started" || r.startedAt !== undefined, "run start/state mismatch");
    check(["stopped", "failed"].includes(String(r.state)) === (r.endedAt !== undefined), "run end/state mismatch");
  }
  if (raw.pr !== undefined) taskPR(raw.pr);
  if (raw.attention !== undefined) attention(raw.attention);
  if (raw.readiness !== undefined) {
    const r = raw.readiness;
    validateReadiness(r);
    check(object(raw.pr) && raw.pr.head === r.head && raw.status === "ready_to_merge" && raw.attention === undefined, "inconsistent readiness");
  }
  check(raw.status !== "ready_to_merge" || raw.readiness !== undefined, "ready requires validation");
  if (raw.archive !== undefined) {
    const a = raw.archive;
    check(object(a) && a.reason === "merged" && stamp(a.mergedAt) && stamp(a.archivedAt), "invalid archive");
    const p = taskPR(a.pr); check(object(raw.pr) && samePR(p, taskPR(raw.pr)), "archive pr mismatch");
  }
  check(raw.history.length === raw.revision, "invalid history revision");
  raw.history.forEach((e, i) => {
    check(object(e) && e.revision === i + 1 && stamp(e.at) && typeof e.kind === "string" && taskStatuses.includes(e.status as TaskStatus), "invalid event");
    if (e.pr !== undefined) taskPR(e.pr);
    if (e.attention !== undefined) attention(e.attention);
    if (e.readiness !== undefined) validateReadiness(e.readiness);
    check(e.status !== "ready_to_merge" || e.readiness !== undefined, "ready event requires validation");
  });
}
async function read(project: string): Promise<Store> {
  projectId(project);
  let bytes: string;
  try { bytes = await readFile(file(project), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: [] }; throw e; }
  const raw: unknown = JSON.parse(bytes);
  check(object(raw) && raw.version === 1 && Array.isArray(raw.tasks), "unsupported/corrupt registry");
  const ids = new Set<string>(), runs = new Set<string>();
  for (const t of raw.tasks) {
    validateTask(t); check(!ids.has(t.id), "duplicate task id"); ids.add(t.id);
    for (const r of t.runs) { check(!runs.has(r.id), "run belongs to multiple tasks"); runs.add(r.id); }
  }
  return raw as unknown as Store;
}
async function update<T>(project: string, action: (s: Store) => T): Promise<T> {
  projectId(project);
  const identity = projectIdentity(project); // never resurrect a deleted/recreated managed project
  return withProjectStateLock(project, async () => {
    assertProjectIdentity(project, identity);
    const store = await read(project), before = JSON.stringify(store);
    const result = action(store), after = JSON.stringify(store);
    if (before !== after) {
      for (const t of store.tasks) validateTask(t);
      const tmp = `${file(project)}.${crypto.randomUUID()}.tmp`;
      try { await writeFile(tmp, after + "\n", { flag: "wx", mode: 0o600 }); await rename(tmp, file(project)); }
      finally { await rm(tmp, { force: true }); }
    }
    return result;
  });
}
function event(t: Task, kind: string, run?: string): void {
  t.updatedAt = new Date().toISOString(); t.revision++;
  t.history.push({ revision: t.revision, at: t.updatedAt, kind, status: t.status, ...(run ? { run } : {}), ...(t.pr ? { pr: { ...t.pr } } : {}), ...(t.attention ? { attention: { ...t.attention } } : {}), ...(t.readiness ? { readiness: { ...t.readiness } } : {}) });
}
function find(s: Store, id: string): Task { const t = s.tasks.find(t => t.id === id); check(t, "task not found"); return t; }
function active(t: Task): void { check(!t.archive, "task is archived"); }
function unready(t: Task): void { delete t.readiness; if (t.status === "ready_to_merge") t.status = "reviewing"; }
function samePR(a: TaskPR, b: TaskPR): boolean { return a.repository === b.repository && a.number === b.number; }
function current(s: Store, run: string): { task: Task; run: TaskRun } | undefined {
  for (const task of s.tasks) { const r = task.runs.at(-1); if (!task.archive && r?.id === run) return { task, run: r }; }
}

export async function allTasks(project: string): Promise<Task[]> { return (await read(project)).tasks; }
export async function getTask(project: string, id: string): Promise<Task> { return find(await read(project), id); }
export async function listTasks(project: string): Promise<TaskRow[]> {
  return (await allTasks(project)).filter(t => !t.archive).map(({ id, name, summary, branch, status, createdAt, updatedAt, attention, pr, runs }) => ({ id, name, summary, branch, status, createdAt, updatedAt, ...(attention ? { attention } : {}), ...(pr ? { pr } : {}), review: reviewProgress(runs) }));
}
export async function taskForRun(project: string, run: string): Promise<Task | undefined> { return current(await read(project), run)?.task; }
/** Caller must have authorization already; id enables idempotent retry, never derives from branch/name. */
export async function registerTask(project: string, input: { id?: string; name: string; summary: string; branch: string; authorized: true }): Promise<Task> {
  check(input.authorized === true, "explicit task authorization is required");
  const id = input.id ?? crypto.randomUUID(); check(uuid(id), "invalid task id");
  const name = text(input.name, 120, "name"), summary = text(input.summary, 500, "summary"), branch = text(input.branch, 250, "branch");
  check(!branch.startsWith("-") && !/[\s~^:?*\[\\]/.test(branch) && !branch.includes("..") && !branch.includes("@{"), "invalid branch");
  return update(project, s => {
    const old = s.tasks.find(t => t.id === id);
    if (old) { check(old.name === name && old.summary === summary && old.branch === branch, "task id already registered with different fields"); return old; }
    check(!s.tasks.some(t => t.branch === branch && t.pr), "branch already has a pr: for a correction to the same unmerged pr, use task list/get and resume its existing taskId and branch without registering again; separate work needs a new branch");
    const now = new Date().toISOString();
    const t: Task = { id, name, summary, branch, status: "queued", createdAt: now, updatedAt: now, revision: 0, runs: [], history: [] };
    event(t, "registered"); s.tasks.push(t); return t;
  });
}
/** Persist before dispatch, but do not assert that a process has started. */
export async function prepareTaskRun(project: string, id: string, branch: string, run: Pick<TaskRun, "id" | "agent" | "role" | "reviewMode">): Promise<void> {
  await update(project, s => {
    const t = find(s, id); active(t); check(t.branch === branch, "task branch mismatch");
    const existing = t.runs.find(r => r.id === run.id);
    if (existing) { check(existing.agent === run.agent && existing.role === run.role, "run identity mismatch"); return; }
    check(!s.tasks.some(x => x.runs.some(r => r.id === run.id)), "duplicate run id");
    check(!s.tasks.some(x => x.branch === branch && x.runs.some(r => r.state === "prepared" || r.state === "started")), "task run still active on branch; reconcile it before retrying");
    for (const other of s.tasks.filter(x => !x.archive && x.branch === branch && x.readiness)) {
      unready(other); other.attention = { kind: "waiting", reason: "new run on this branch; readiness must be validated again" }; event(other, "readiness_invalidated", run.id);
    }
    t.runs.push({ ...run, state: "prepared", preparedAt: new Date().toISOString() });
    t.status = run.role === "worker" ? "queued" : "reviewing";
    t.attention = { kind: "waiting", reason: "launch prepared; agent has not started" }; event(t, "run_prepared", run.id);
  });
}
/** Called by the supervisor inside the actual child, never by spawn's successful return. */
export async function startTaskRun(project: string, run: string): Promise<void> {
  if (!(await taskForRun(project, run))) return;
  await update(project, s => {
    const c = current(s, run); if (!c || c.run.state !== "prepared") return;
    c.run.state = "started"; c.run.startedAt = new Date().toISOString();
    c.task.status = c.run.role === "worker" ? "working" : "reviewing";
    delete c.task.attention; event(c.task, "run_started", run);
  });
}
export async function stopTaskRun(project: string, run: string, kind: AttentionKind, reason: string, failedLaunch = false): Promise<void> {
  if (!(await taskForRun(project, run))) return;
  const note = attention({ kind, reason });
  await update(project, s => {
    const c = current(s, run); if (!c) return;
    const ended = ["stopped", "failed"].includes(c.run.state);
    // Cancellation can race a normal final report/close; it still wins for this
    // exact run. Other repeated close notifications remain no-ops.
    if (ended && (kind !== "cancelled" || c.task.attention?.kind === "cancelled")) return;
    if (!ended) { c.run.state = failedLaunch && !c.run.startedAt ? "failed" : "stopped"; c.run.endedAt = new Date().toISOString(); }
    if (kind !== "waiting") {
      // One reviewer may explicitly validate several tasks included in its PR.
      // A cancelled/crashed run cannot leave those earlier tasks looking ready.
      for (const other of s.tasks.filter(t => !t.archive && t.id !== c.task.id && t.readiness?.run === run)) {
        unready(other); other.attention = note; event(other, "readiness_invalidated", run);
      }
      unready(c.task);
    }
    const previous = c.task.attention;
    const preserve = previous?.kind === "cancelled" || ((kind === "waiting" || kind === "unknown") && previous && previous.kind !== "waiting");
    if (!c.task.readiness && !preserve) c.task.attention = note;
    event(c.task, failedLaunch ? "launch_failed" : "run_stopped", run);
  });
}
/** Conservative: a shell tool or a new instruction can change code even in the same reviewer run. */
export async function invalidateTaskBranch(project: string, run: string): Promise<void> {
  const t = await taskForRun(project, run); if (!t) return;
  await update(project, s => {
    for (const other of s.tasks.filter(x => !x.archive && x.branch === t.branch && x.readiness)) {
      unready(other); other.attention = { kind: "waiting", reason: "branch activity after validation; validate readiness again" }; event(other, "readiness_invalidated", run);
    }
  });
}
export async function setTaskAttention(project: string, id: string, note: TaskAttention, expectedRevision?: number): Promise<Task> {
  note = attention(note);
  return update(project, s => {
    const t = find(s, id); active(t);
    if (expectedRevision !== undefined) check(t.revision === expectedRevision, "task changed; retry attention update");
    if (JSON.stringify(t.attention) === JSON.stringify(note) && !t.readiness) return t;
    unready(t); t.attention = note; event(t, "attention"); return t;
  });
}
/** PR snapshots are obtained from GitHub, not from a report or a guessed branch URL. */
export interface PRObservation {
  pr: TaskPR; branch: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt?: string;
  ready: boolean; checks: "passed" | "not_configured" | "pending" | "failed" | "unknown";
}
export async function observeTaskPR(project: string, id: string, observation: PRObservation, expectedRevision?: number): Promise<Task> {
  const pr = taskPR(observation.pr);
  return update(project, s => {
    const t = find(s, id);
    if (t.archive) return t;
    if (expectedRevision !== undefined) check(t.revision === expectedRevision, "task changed during pr lookup; retry");
    check(t.branch === observation.branch, "pr branch mismatch");
    check(!t.pr || samePR(t.pr, pr), "task already associated with another pr");
    const before = JSON.stringify(t);
    if (t.pr?.head !== pr.head || !observation.ready || observation.state !== "OPEN") unready(t);
    t.pr = pr;
    if (observation.state === "MERGED") {
      check(stamp(observation.mergedAt), "merged observation needs mergedAt");
      t.archive = { reason: "merged", mergedAt: observation.mergedAt, archivedAt: new Date().toISOString(), pr };
      delete t.attention;
    } else if (observation.state === "CLOSED") t.attention = { kind: "closed", reason: "pr closed without merging" };
    else if (before !== JSON.stringify(t) && !t.readiness && (!t.attention || t.attention.kind === "waiting")) t.attention = { kind: "waiting", reason: "pr observed; readiness needs explicit validation" };
    if (before !== JSON.stringify(t)) event(t, t.archive ? "merged" : "pr_observed");
    return t;
  });
}
/** Only a currently started reviewer can attest readiness, after validating this exact PR head. */
export async function validateTaskReadiness(project: string, id: string, input: { run: string; revision: number; observation: PRObservation; validation: string; validated: true }): Promise<Task> {
  const pr = taskPR(input.observation.pr), validation = text(input.validation, 2000, "validation");
  check(input.validated === true && input.observation.ready && input.observation.state === "OPEN" && ["passed", "not_configured"].includes(input.observation.checks), "pr is not validated ready");
  return update(project, s => {
    const t = find(s, id); active(t);
    const reviewer = current(s, input.run);
    check(reviewer?.run.role === "reviewer" && reviewer.run.state === "started" && reviewer.task.branch === t.branch && t.runs.some(r => r.startedAt), "readiness requires an active reviewer on the task branch");
    check(t.attention?.kind !== "cancelled", "cancelled task needs explicit authorized continuation");
    check(t.revision === input.revision && t.pr && samePR(t.pr, pr) && t.pr.head === pr.head && t.branch === input.observation.branch, "task/pr changed during validation; retry");
    if (t.readiness?.run === input.run && t.readiness.head === pr.head && t.readiness.validation === validation && t.readiness.checks === input.observation.checks) return t;
    t.readiness = { head: pr.head, run: input.run, validatedAt: new Date().toISOString(), validation, checks: input.observation.checks as "passed" | "not_configured" };
    t.status = "ready_to_merge"; delete t.attention; event(t, "readiness_validated", input.run); return t;
  });
}
/** Exact repository/number/link match; independent of destructive merge cleanup or its claims. */
export async function archiveMergedTasks(project: string, pr: TaskPR, mergedAt: string): Promise<void> {
  pr = taskPR(pr); check(stamp(mergedAt), "invalid merge timestamp");
  const matches = (await allTasks(project)).filter(t => !t.archive && t.pr && samePR(t.pr, pr));
  for (const t of matches) await observeTaskPR(project, t.id, { pr, branch: t.branch, state: "MERGED", mergedAt, ready: false, checks: "unknown" });
}

/** Only confirmed starts count; CI-only runs are not code reviews. */
export function reviewProgress(runs: TaskRun[]): { rounds: number; unknown: boolean; ci: boolean } {
  const started = runs.filter(r => r.role === "reviewer" && r.startedAt);
  return { rounds: started.filter(r => r.reviewMode === "review").length,
    unknown: started.some(r => !r.reviewMode), ci: started.at(-1)?.reviewMode === "watch-ci" };
}
