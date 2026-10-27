import { check, sha, type Task } from '../../../protocol/tasks';
import type { Checkpoint, StackBase } from './dependency-policy';
import type { ReplayReceipt } from './dependency-replay';

/** Stored in ledger safety JSON, not UI checkpoint timestamps or task ordering. */
export interface DependencyProvenance {
  version: 1;
  checkpoint?: Checkpoint;
  stack?: StackBase;
  replay?: ReplayReceipt;
}
export type ProvenanceTask = Task & { dependencyProvenance?: DependencyProvenance };
export function provenance(task: Task): DependencyProvenance | undefined {
  return (task as ProvenanceTask).dependencyProvenance;
}
export function validateProvenance(task: Task): void {
  const p = provenance(task); if (!p) return;
  check(p.version === 1, 'unsupported dependency provenance');
  if (p.checkpoint) check(p.checkpoint.taskId === task.id && Number.isSafeInteger(p.checkpoint.revision) &&
    p.checkpoint.revision > 0 && p.checkpoint.revision <= task.revision && sha(p.checkpoint.commit) &&
    p.checkpoint.clean === true && p.checkpoint.quiescent === true, 'invalid dependency checkpoint');
  if (p.stack) {
    const s = p.stack;
    check(s.taskId === task.id && Number.isSafeInteger(s.revision) && s.revision > 0 && s.revision <= task.revision &&
      sha(s.baseCommit) && sha(s.defaultCommit) && Array.isArray(s.prerequisites), 'invalid stack provenance');
    const seen = new Set<string>();
    for (const dep of s.prerequisites) {
      check(typeof dep.taskId === 'string' && dep.taskId !== task.id && !seen.has(dep.taskId) &&
        Number.isSafeInteger(dep.revision) && dep.revision > 0 && sha(dep.commit), 'invalid stack prerequisite'); seen.add(dep.taskId);
    }
  }
  if (p.replay) {
    const r = p.replay;
    check(p.stack && JSON.stringify(r.stack) === JSON.stringify(p.stack) && sha(r.oldHead) && sha(r.newHead) && sha(r.onto) &&
      r.isolatedReplay === true && /^refs\/orca\/dependency-replays\/[0-9a-f-]{36}$/.test(r.protectedRef) &&
      Number.isFinite(Date.parse(r.createdAt)), 'invalid replay receipt');
  }
}
