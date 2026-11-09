// Pure merge rules for the non-transcript parts of a session (tasks and questions).
// Nothing here reads or writes disk. "source" is the incoming side, "dest" the local one.
//
// Direction of a merged entity: "equal", "source" (the result only adds source content to dest),
// "dest" (source adds nothing), or "both" (each side contributed something the other lacked).
// Timestamps never decide anything.

import type { Question } from "../../protocol";
import type { Task } from "../../protocol/task";

export type Direction = "equal" | "source" | "dest" | "both";
export interface Merged<T> { value: T; direction: Direction; notes: string[]; conflicts: string[] }

export const INTERRUPTED_KIND = "transfer_interrupted";
export const INTERRUPTED_REASON = "interrupted by session transfer";
const json = (v: unknown) => JSON.stringify(v);
/** A task's comparable form: `number` is project-local and `checkpoints` are derived, so neither tells two machines apart. */
const canon = (t: Task) => json({ ...t, number: undefined, checkpoints: undefined });

/** Compare a merge result with each input as sets of canonical records. */
export function directionOf(result: string[], source: string[], dest: string[]): Direction {
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  const fromSource = !same(result, dest), fromDest = !same(result, source);
  return fromSource && fromDest ? "both" : fromSource ? "source" : fromDest ? "dest" : "equal";
}

const isPrefix = (short: unknown[], long: unknown[]) => short.length <= long.length && short.every((e, i) => json(e) === json(long[i]));
const shorter = (a: unknown[], b: unknown[]) => isPrefix(a, b) && a.length < b.length;
const stripAnnotations = (history: Task["history"]) => {
  let end = history.length;
  while (end > 0 && history[end - 1]!.kind === INTERRUPTED_KIND) end--;
  return history.slice(0, end);
};

/** Archived (merged) tasks are terminal: the archived side wins, two archives must be the same pull request. */
function mergeArchived(s: Task, d: Task, label: string, notes: string[]): Task | string {
  if (s.archive && d.archive) {
    const same = s.archive.pr.repository === d.archive.pr.repository && s.archive.pr.number === d.archive.pr.number;
    return same ? d : `${label}: archived against different pull requests`;
  }
  const sending = !!s.archive;
  notes.push(`${label}: archived (merged) on the ${sending ? "sending" : "receiving"} side; archive ${sending ? "wins" : "kept"}`);
  return sending ? s : d;
}

/** Histories compared by prefix; an import-side "interrupted" annotation is not independent work. */
function mergeHistories(s: Task, d: Task, label: string): Task | string {
  if (shorter(s.history, d.history)) return d;
  if (shorter(d.history, s.history)) return s;
  const sh = stripAnnotations(s.history), dh = stripAnnotations(d.history);
  if (shorter(dh, sh)) return s;
  if (shorter(sh, dh)) return d;
  if (json(sh) === json(dh)) return s.history.length > d.history.length ? s : d.history.length > s.history.length ? d : `${label}: same history but different fields`;
  const common = sh.findIndex((e, i) => json(e) !== json(dh[i]));
  return `${label}: histories diverged after ${common === -1 ? Math.min(sh.length, dh.length) : common} events (sending side ${s.history.length}, receiving side ${d.history.length})`;
}

/** The task to keep, or a conflict description. */
function mergeTask(s: Task, d: Task, notes: string[]): Task | string {
  const label = `task ${s.id} (${d.name})`;
  if (s.archive || d.archive) return mergeArchived(s, d, label, notes);
  return canon(s) === canon(d) ? d : mergeHistories(s, d, label);
}

/** Union by task id (receiving side's order first, new tasks appended in the sending side's order). A kept task from the
 * sending side takes the receiving side's project-local `number`. */
export function mergeTasks(source: Task[] | undefined, dest: Task[] | undefined): Merged<Task[]> {
  const notes: string[] = [], conflicts: string[] = [];
  const s = source ?? [], d = dest ?? [];
  const byId = new Map(s.map(t => [t.id, t]));
  const tasks: Task[] = [];
  for (const task of d) {
    const other = byId.get(task.id);
    if (!other) { tasks.push(task); continue; }
    const kept = mergeTask(other, task, notes);
    if (typeof kept === "string") { conflicts.push(kept); tasks.push(task); }
    else tasks.push(kept === task ? task : { ...kept, number: task.number });
  }
  const have = new Set(d.map(t => t.id));
  for (const task of s) if (!have.has(task.id)) tasks.push(task);
  return { value: tasks, notes, conflicts, direction: directionOf(tasks.map(canon), s.map(canon), d.map(canon)) };
}

const isActive = (t: Task) => t.runs.some(r => r.state === "prepared" || r.state === "started");
/** Whether a task is mid-flight: a run that would have been live, or one that was being prepared. */
export const unfinished = (t: Task) => !t.archive && isActive(t);

/** Stop a task that was mid-flight on the other machine: runs stopped, attention unknown, one event saying why. */
function interrupted(original: Task, at: string): Task {
  const t = structuredClone(original);
  for (const run of t.runs) if (run.state === "prepared" || run.state === "started") { run.state = "stopped"; run.endedAt = at; }
  if (t.readiness) { delete t.readiness; if (t.status === "ready_to_merge") t.status = "reviewing"; }
  if (t.attention?.kind !== "cancelled") t.attention = { kind: "unknown", reason: INTERRUPTED_REASON };
  t.updatedAt = at; t.revision++;
  t.history.push({ revision: t.revision, at, kind: INTERRUPTED_KIND, status: t.status, ...(t.pr ? { pr: { ...t.pr } } : {}), ...(t.attention ? { attention: { ...t.attention } } : {}) });
  return t;
}

/**
 * Imported unfinished tasks never resume by themselves: active runs become stopped, attention becomes
 * "unknown" and an event records why. Only tasks in `ids` (those that came from the other machine) change.
 */
export function interruptTasks(tasks: Task[], ids: Set<string>, at: string): { tasks: Task[]; changed: string[] } {
  const changed: string[] = [];
  const next = tasks.map(original => {
    if (!ids.has(original.id) || !unfinished(original)) return original;
    changed.push(original.id);
    return interrupted(original, at);
  });
  return { tasks: next, changed };
}

/** 0 open; 1 withdrawn by the orchestrator (skipped with a reason); 2 settled by the user (answered, or skipped/deleted).
 * A user's answer wins over a withdrawal, as in core/data/inbox/questions.ts. */
const closure = (q: Question) => q.status === "open" ? 0 : q.status === "skipped" && q.reason !== undefined ? 1 : 2;
const sameBody = (a: Question, b: Question) => json([a.text, a.ts, a.options, a.default]) === json([b.text, b.ts, b.options, b.default]);

/** Union by id; a further-closed state beats a less closed one; two different closures of one rank (or different texts) are a conflict. */
export function mergeQuestions(source: Question[], dest: Question[]): Merged<Question[]> {
  const notes: string[] = [], conflicts: string[] = [];
  const byId = new Map(source.map(q => [q.id, q]));
  const out: Question[] = [];
  for (const q of dest) {
    const other = byId.get(q.id);
    if (!other || json(other) === json(q)) { out.push(q); continue; }
    if (!sameBody(other, q)) { conflicts.push(`question ${q.id}: different text/options on the two sides`); out.push(q); continue; }
    if (closure(other) === closure(q)) { conflicts.push(`question ${q.id}: closed differently (${q.status} here, ${other.status} there)`); out.push(q); continue; }
    const closed = closure(other) > closure(q) ? other : q;
    notes.push(`question ${q.id}: ${closed.status} on ${closed === other ? "the sending" : "the receiving"} side wins`);
    out.push(closed);
  }
  const have = new Set(dest.map(q => q.id));
  for (const q of source) if (!have.has(q.id)) out.push(q);
  return { value: out, notes, conflicts, direction: directionOf(out.map(json), source.map(json), dest.map(json)) };
}

export interface UnitInput { transcript: Direction; tasks: Direction; questions: Direction }

/**
 * The orchestrator unit (orchestrator transcript, tasks, questions, model settings) must not mix two machines' states.
 * When the orchestrator transcript moves one way, tasks and questions may not have moved the other way.
 * With equal transcripts, tasks/questions are plain unions. Returns the refusal reason, or undefined.
 */
export function unitConflict(u: UnitInput): string | undefined {
  if (u.transcript === "equal") return;
  const wrong: Direction[] = u.transcript === "source" ? ["dest", "both"] : ["source", "both"];
  const bad = (["tasks", "questions"] as const).filter(k => wrong.includes(u[k]));
  if (!bad.length) return;
  return `mixed sources for the orchestrator unit: the orchestrator transcript is newer on the ${u.transcript === "source" ? "sending" : "receiving"} side, ` +
    `but ${bad.join(" and ")} changed the other way or on both sides. Bring both machines to one state first (transfer the newer side to the other, or use --as to import a separate copy)`;
}
