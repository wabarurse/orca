/** Legacy isolated policy-test adapters, NOT mounted production authority.
 * Production task actions and readiness share dependency-verification.ts.
 * These adapters inject synthetic authority for policy/replay/lock tests only.
 */
import { check, type Task } from '../../../protocol/tasks';
import { withDependencyTaskOwnership } from './tasks';
import { provenance } from './dependency-provenance';
import { assertPrerequisitesMerged, assertPublication, resolveStackBase, type DependencySnapshot, type PublicationState } from './dependency-policy';
import { cleanBranchHead, replayStack, dependencyGit } from './dependency-replay';
import { gitAncestry } from './dependency-git';

/** Authorization and stronger requirements are runtime inputs, NOT tool arguments.
 * Existing registration establishes task authorization; deployments need a separate
 * trusted requirements provider. Absence is unknown, never implicitly satisfied.
 */
export interface DependencyAuthority {
  authorized: ReadonlySet<string>;
  requirements: DependencySnapshot['requirements'];
}
function snapshot(tasks: Task[], authority: DependencyAuthority): DependencySnapshot {
  return { tasks, ...authority, checkpoints: tasks.flatMap(t => provenance(t)?.checkpoint ? [provenance(t)!.checkpoint!] : []) };
}

export { assertRepository } from './dependency-verification';
import { assertRepository } from './dependency-verification';
export async function captureDependencyCheckpoint(project: string, id: string, branch: string, cwd: string) {
  return withDependencyTaskOwnership(project, id, branch, async (task, _tasks, save) => {
    await assertRepository(project, cwd);
    const commit = await cleanBranchHead(cwd, branch);
    const checkpoint = { taskId: task.id, revision: task.revision + 1, commit, clean: true, quiescent: true };
    save({ ...provenance(task), version: 1, checkpoint });
    return checkpoint;
  });
}
export async function recordDependencyStack(project: string, id: string, branch: string, cwd: string,
  defaultCommit: string, selectedCommit: string, authority: DependencyAuthority) {
  return withDependencyTaskOwnership(project, id, branch, async (task, tasks, save) => {
    await assertRepository(project, cwd);
    check(!provenance(task)?.stack, 'stack provenance is immutable; explicit recovery required');
    const stack = await resolveStackBase(snapshot(tasks, authority), task.id, defaultCommit, selectedCommit, gitAncestry(cwd));
    // Runner will consume this persisted base only for a fresh branch. Existing branch
    // creation/ancestry and repo binding checks must be integrated before exposing it.
    save({ version: 1, stack }); return stack;
  });
}
export async function prepareDependencyReplay(project: string, id: string, branch: string, cwd: string,
  latestDefault: string, authority: DependencyAuthority) {
  return withDependencyTaskOwnership(project, id, branch, async (task, tasks, save) => {
    await assertRepository(project, cwd);
    assertPrerequisitesMerged(snapshot(tasks, authority), task.id);
    const p = provenance(task); check(p?.stack, 'recorded stack required');
    const receipt = await replayStack(cwd, branch, p.stack, latestDefault);
    save({ version: 1, stack: p.stack, replay: receipt }); return receipt;
  });
}

/** Future task publication action calls this while no agent is writing the branch.
 * refresh must read GitHub/default and return trusted evidence without nesting ledger
 * writes (the lock is held). Pending merges are persisted by task pr before this call.
 * publish performs push/create only, never merge; callers must reconcile partial success.
 * Still unmounted: generic bash is not intercepted or claimed to be a sandbox.
 */
export async function coordinateDependencyPublication<T>(project: string, id: string, branch: string, cwd: string,
  refresh: (tasks: readonly Task[]) => Promise<{ authority: DependencyAuthority; state: PublicationState }>,
  publish: (head: string) => Promise<T>): Promise<T> {
  return withDependencyTaskOwnership(project, id, branch, async (task, tasks) => {
    await assertRepository(project, cwd);
    const { authority, state } = await refresh(tasks);
    check(state.taskId === task.id, 'publication task mismatch');
    const p = provenance(task), head = await cleanBranchHead(cwd, branch);
    check(head === state.head, 'publication head changed');
    // Discard caller replay flags: only use receipts constructed and stored by runtime.
    const actual = { ...state, clean: true, update: p?.replay };
    if (p?.replay) check(await dependencyGit(cwd, ['rev-parse', '--verify', `${p.replay.protectedRef}/candidate`]) === head, 'replay candidate does not match checkout');
    await assertPublication(snapshot(tasks, authority), actual, gitAncestry(cwd), p?.stack);
    check(await cleanBranchHead(cwd, branch) === head, 'branch changed before publication');
    return publish(head);
  });
}
