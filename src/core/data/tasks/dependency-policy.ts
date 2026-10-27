/** Future dispatch/publication policy. Pure snapshots: never inspect another worktree.
 * Callers must obtain authorization, checkpoint and merge evidence from trusted runtime
 * storage under the project lock, not from model-supplied booleans. Not yet mounted.
 */
import { check, sha, taskDependencies, type Task } from '../../../protocol/tasks';

export interface Checkpoint {
  taskId: string;
  revision: number;
  commit: string;
  /** Captured by the prerequisite worker with a clean index/worktree and no active writer. */
  clean: boolean;
  quiescent: boolean;
}
export interface DependencySnapshot {
  tasks: readonly Task[];
  /** Explicit authorization, not inferred from branch naming or ordering. */
  authorized: ReadonlySet<string>;
  checkpoints: readonly Checkpoint[];
  /** Stronger prerequisites (deployment etc.) must be independently satisfied. */
  requirements: ReadonlyMap<string, 'satisfied' | 'pending' | 'unknown'>;
}
export interface StackBase {
  taskId: string;
  revision: number;
  defaultCommit: string;
  baseCommit: string;
  prerequisites: { taskId: string; revision: number; commit: string }[];
}
export type Ancestor = (ancestor: string, descendant: string) => Promise<boolean>;
const key = (id: string) => id.toLowerCase();
function commit(value: string): string { check(sha(value), 'immutable commit required'); return value; }

/** Validate the entire explicit DAG, including archived nodes; never infer edges. */
export function dependencyClosure(snapshot: DependencySnapshot, id: string): Task[] {
  const index = new Map<string, Task>();
  for (const task of snapshot.tasks) {
    check(!index.has(key(task.id)), 'ambiguous task identity'); index.set(key(task.id), task);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string, result: Task[]): void {
    const k = key(id), task = index.get(k);
    check(task, 'missing dependency'); check(!visiting.has(k), 'task dependency cycle');
    if (visited.has(k)) return;
    visiting.add(k);
    for (const dep of taskDependencies(task.dependsOn, task.id)) visit(dep, result);
    visiting.delete(k); visited.add(k); result.push(task);
  }
  for (const task of snapshot.tasks) visit(task.id, []);
  visited.clear();
  const result: Task[] = []; visit(id, result);
  for (const task of result) {
    check(snapshot.authorized.has(task.id), 'unauthorized task');
    check(!task.attention || !['cancelled', 'blocked', 'closed', 'unknown'].includes(task.attention.kind), 'task attention blocks dependency work');
    check(snapshot.requirements.get(task.id) === 'satisfied', 'stronger requirements not satisfied');
  }
  check(!result.at(-1)!.archive, 'target task is archived');
  return result;
}

/** Open prerequisites permit local-only preparation from explicitly selected immutable code.
 * A common ancestor is NOT sufficient: the selected base must contain every checkpoint.
 * Divergent prerequisites require a separately authorized composition checkpoint; this
 * policy never merges work, chooses a branch arbitrarily, or reads a live worktree.
 */
export async function resolveStackBase(snapshot: DependencySnapshot, id: string, defaultCommit: string,
  selectedCommit: string, ancestor: Ancestor): Promise<StackBase> {
  commit(defaultCommit); commit(selectedCommit);
  const closure = dependencyClosure(snapshot, id), target = closure.pop()!;
  check(!target.pr, 'stack preparation requires an unpublished task');
  check(await ancestor(defaultCommit, selectedCommit), 'base does not contain current default');
  const prerequisites: StackBase['prerequisites'] = [];
  for (const task of closure) {
    if (task.archive) continue;
    const matches = snapshot.checkpoints.filter(c => key(c.taskId) === key(task.id));
    check(matches.length === 1, 'missing or ambiguous prerequisite checkpoint');
    const checkpoint = matches[0]!;
    check(checkpoint.revision === task.revision && checkpoint.clean && checkpoint.quiescent, 'stale or unusable prerequisite checkpoint');
    check(!task.runs.some(r => r.state === 'prepared' || r.state === 'started'), 'prerequisite still has an active writer');
    commit(checkpoint.commit);
    check(await ancestor(checkpoint.commit, selectedCommit), 'base omits prerequisite code');
    prerequisites.push({ taskId: task.id, revision: task.revision, commit: checkpoint.commit });
  }
  // No arbitrary extra commits: until composition provenance exists, only a checkpoint
  // that already contains all prerequisites is allowed. Divergence fails closed.
  check(selectedCommit === defaultCommit || prerequisites.some(p => p.commit === selectedCommit), 'unproven composition base');
  return { taskId: target.id, revision: target.revision, defaultCommit, baseCommit: selectedCommit, prerequisites };
}

/** Archive is written only from verified GitHub MERGED observations by existing storage.
 * Readiness, PR existence, branch ancestry and stopped agents are not merge evidence.
 */
export function assertPrerequisitesMerged(snapshot: DependencySnapshot, id: string): void {
  const closure = dependencyClosure(snapshot, id); closure.pop();
  for (const task of closure) {
    check(task.archive?.reason === 'merged' && task.pr &&
      task.archive.pr.repository === task.pr.repository && task.archive.pr.number === task.pr.number &&
      Number.isFinite(Date.parse(task.archive.mergedAt)), 'prerequisite merge is not verified');
  }
}

export interface PublicationState {
  taskId: string;
  head: string;
  defaultCommit: string;
  clean: boolean;
  /** Worker evidence bound to the updated state; reviewer never reruns it. */
  workerEvidence: { head: string; defaultCommit: string; commands: readonly string[] };
  reviewedHead: string;
  /** For stacked work, trusted receipt for replaying ONLY baseCommit..oldHead. */
  update?: { stack: StackBase; oldHead: string; newHead: string; onto: string; isolatedReplay: boolean };
}

export async function assertPublication(snapshot: DependencySnapshot, state: PublicationState, ancestor: Ancestor,
  recordedStack?: StackBase): Promise<void> {
  assertPrerequisitesMerged(snapshot, state.taskId);
  commit(state.head); commit(state.defaultCommit);
  check(state.clean, 'publication requires clean worktree');
  check(await ancestor(state.defaultCommit, state.head), 'update onto latest default before publication');
  check(state.workerEvidence.head === state.head && state.workerEvidence.defaultCommit === state.defaultCommit &&
    state.workerEvidence.commands.length > 0 && state.workerEvidence.commands.every(c => c.trim()), 'affected-change worker evidence required');
  check(state.reviewedHead === state.head, 'code review does not match updated head');
  if (recordedStack) {
    const update = state.update;
    check(recordedStack.taskId === state.taskId && update &&
      JSON.stringify(update.stack) === JSON.stringify(recordedStack) && update.newHead === state.head &&
      update.onto === state.defaultCommit && update.isolatedReplay, 'stack-only replay receipt required');
    commit(update.oldHead);
    check(await ancestor(recordedStack.baseCommit, update.oldHead), 'recorded stack base is not an ancestor');
  } else check(!state.update, 'unrecorded stack update');
}

/** Future authoritative publication entrypoint: gate BEFORE either push or gh pr create.
 * The adapter must hold exclusive task/branch ownership, refresh latest default/merges,
 * persist stack provenance and reject stale receipts. Generic bash is NOT intercepted.
 * No shell parsing, automatic merge, deployment, destructive rebase, or CI reruns here.
 */
export async function gatedPublication<T>(load: () => Promise<{
  snapshot: DependencySnapshot; state: PublicationState; stack?: StackBase;
}>, ancestor: Ancestor, publish: () => Promise<T>): Promise<T> {
  const { snapshot, state, stack } = await load();
  await assertPublication(snapshot, state, ancestor, stack);
  return publish();
}
