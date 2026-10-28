import type { Task } from "../../../protocol/task";
import { assertPrerequisitesMerged, type DependencySnapshot } from './dependency-policy';
import { provenance } from './dependency-provenance';

/** Task registration is the durable authorization boundary. The current ledger has
 * code-prerequisite edges, not deployment requirements. Never infer stronger gates
 * from prose; existing blocked/cancelled/unknown attention remains fail-closed.
 */
export function ledgerDependencies(tasks: readonly Task[]): DependencySnapshot {
  return { tasks, authorized: new Set(tasks.filter(t => !t.removedAt || t.archive).map(t => t.id)),
    requirements: new Map(tasks.map(t => [t.id, 'satisfied' as const])),
    checkpoints: tasks.flatMap(t => {
      const p = provenance(t), cp = p?.checkpoint;
      if (!cp) return [];
      // Runtime checkpoint from an active worker becomes usable only after that exact
      // run stops. Later dispatch cannot reuse it, even on the same branch.
      if (p.checkpointRun && (t.runs.at(-1)?.id !== p.checkpointRun || t.runs.at(-1)?.state !== 'stopped')) return [];
      return [{ ...cp, revision: p.checkpointRun ? t.revision : cp.revision }];
    }) };
}
export function assertLedgerPrerequisitesMerged(tasks: readonly Task[], id: string): void {
  assertPrerequisitesMerged(ledgerDependencies(tasks), id);
}
