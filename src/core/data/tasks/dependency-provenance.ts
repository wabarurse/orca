import { check, sha, type Task } from '../../../protocol/tasks';
import type { Checkpoint, StackBase } from './dependency-policy';
import type { ReplayReceipt } from './dependency-replay';

/** Stored in ledger safety JSON, not UI checkpoint timestamps or task ordering. */
export interface DependencyProvenance {
  version: 1;
  checkpoint?: Checkpoint;
  checkpointRun?: string;
  checks?: { head: string; defaultCommit: string; run: string; commands: string[]; validation: string };
  review?: { head: string; run: string; validation: string };
  stack?: StackBase;
  replay?: ReplayReceipt;
}
export type ProvenanceTask = Task & { dependencyProvenance?: DependencyProvenance };
export function provenance(task: Task): DependencyProvenance | undefined {
  return (task as ProvenanceTask).dependencyProvenance;
}
function revision(value: number, task: Task): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= task.revision;
}
function worker(task: Task, run: string): boolean { return task.runs.some(r => r.id === run && r.role === 'worker'); }
function validation(value: string): boolean { return typeof value === 'string' && !!value.trim(); }
function checkpoint(task: Task, p: DependencyProvenance): void {
  const c = p.checkpoint;
  if (c) check(c.taskId === task.id && revision(c.revision, task) && sha(c.commit) && c.clean === true && c.quiescent === true, 'invalid dependency checkpoint');
  if (p.checkpointRun) check(worker(task, p.checkpointRun), 'invalid checkpoint owner');
}
function workerEvidence(task: Task, p: DependencyProvenance): void {
  const c = p.checks; if (!c) return;
  check(sha(c.head) && sha(c.defaultCommit) && worker(task, c.run), 'invalid worker evidence owner/head');
  check(Array.isArray(c.commands) && c.commands.length > 0 && c.commands.every(validation) && validation(c.validation), 'invalid worker evidence');
}
function reviewEvidence(task: Task, p: DependencyProvenance): void {
  const r = p.review; if (!r) return;
  check(sha(r.head) && validation(r.validation), 'invalid review evidence');
  check(task.runs.some(run => run.id === r.run && run.role === 'reviewer' && run.reviewMode === 'review'), 'invalid review owner');
}
function stack(task: Task, s: StackBase): void {
  check(s.taskId === task.id && revision(s.revision, task) && sha(s.baseCommit) && sha(s.defaultCommit) && Array.isArray(s.prerequisites), 'invalid stack provenance');
  const seen = new Set<string>();
  for (const dep of s.prerequisites) {
    prerequisite(task, dep, seen); seen.add(dep.taskId);
  }
}
function prerequisite(task: Task, dep: StackBase['prerequisites'][number], seen: Set<string>): void {
  check(typeof dep.taskId === 'string' && dep.taskId !== task.id && !seen.has(dep.taskId), 'invalid stack prerequisite identity');
  check(Number.isSafeInteger(dep.revision) && dep.revision > 0 && sha(dep.commit), 'invalid stack prerequisite');
}
function receipt(p: DependencyProvenance, r: ReplayReceipt): void {
  check(p.stack && JSON.stringify(r.stack) === JSON.stringify(p.stack), 'invalid replay stack');
  check(sha(r.oldHead) && sha(r.newHead) && sha(r.onto) && r.isolatedReplay === true, 'invalid replay receipt');
  check(/^refs\/orca\/dependency-replays\/[0-9a-f-]{36}$/.test(r.protectedRef) && Number.isFinite(Date.parse(r.createdAt)), 'invalid replay reference');
}
export function validateProvenance(task: Task): void {
  const p = provenance(task); if (!p) return;
  check(p.version === 1, 'unsupported dependency provenance');
  checkpoint(task, p); workerEvidence(task, p); reviewEvidence(task, p);
  if (p.stack) stack(task, p.stack);
  if (p.replay) receipt(p, p.replay);
}
