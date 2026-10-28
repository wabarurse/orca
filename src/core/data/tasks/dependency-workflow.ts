/** Supported workflow used by the existing task tool. No shell publication API. */
import { check, type Task } from "../../../protocol/task";
interface ToolContext { project: string; role: string; run?: string; branch?: string; cwd: string; signal?: AbortSignal }
import { allTasks, observeTaskPR, withDependencyTaskOwnership } from './tasks';
import { ghTaskPR, originRepo } from './github';
import { dependencyClosure, resolveStackBase } from './dependency-policy';
import { ledgerDependencies, assertLedgerPrerequisitesMerged } from './dependency-ledger';
import { provenance } from './dependency-provenance';
import { cleanBranchHead, dependencyGit, replayStack } from './dependency-replay';
import { gitAncestry } from './dependency-git';
import { latestDefault, publishBranch } from './dependency-remote';
import { effectiveFlow } from '../projects';
import { assertRepository, adoptedReplay, verifyPublicationState } from './dependency-verification';
import type { DependencyProvenance } from './dependency-provenance';

async function refreshMerges(project: string, id: string): Promise<void> {
  const tasks = await allTasks(project), closure = dependencyClosure(ledgerDependencies(tasks), id); closure.pop();
  for (const dep of closure) {
    if (dep.archive) continue;
    check(dep.pr, `prerequisite ${dep.id} has no verified PR`);
    const observed = await ghTaskPR(project, dep.pr);
    check(observed?.state === 'MERGED', `prerequisite ${dep.id} is not verified merged`);
    await observeTaskPR(project, dep.id, observed);
  }
}
function owner(task: Task, ctx: ToolContext, role: 'worker' | 'reviewer', mode?: 'review' | 'watch-ci'): void {
  const r = task.runs.at(-1);
  check(ctx.role === role && r?.role === role && r.id === ctx.run && r.state === 'started' &&
    (!mode || r.reviewMode === mode), `requires active ${mode ?? role} run`);
}
function evidence(input: Record<string, unknown>): string {
  check(typeof input.validation === 'string' && input.validation.trim() && input.validation.length <= 2000, 'validation evidence required (max 2000 characters)');
  return input.validation.trim();
}

/** Explicit fresh-base resolution before spawn. Existing branches are never retargeted. */
export async function prepareStackSpawn(project: string, taskId: string, branch: string, cwd: string, selected: string): Promise<void> {
  await withDependencyTaskOwnership(project, taskId, branch, async (task, tasks, save) => {
    await assertRepository(project, cwd);
    const p = provenance(task);
    if (p?.stack) { check(p.stack.baseCommit === selected, 'recorded stack base is immutable'); return; }
    // Do not graft stack metadata onto pre-existing user work.
    const refs = await dependencyGit(cwd, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]);
    check(!refs, 'explicit stack base requires a new branch');
    const current = await latestDefault(cwd);
    const stack = await resolveStackBase(ledgerDependencies(tasks), task.id, current.commit, selected, gitAncestry(cwd));
    await dependencyGit(cwd, ['update-ref', `refs/orca/stack-bases/${task.id}`, stack.baseCommit, '0'.repeat(stack.baseCommit.length)]);
    save({ version: 1, stack });
  });
}

interface ActionContext {
  current: Task; tasks: Task[]; save: (p: DependencyProvenance) => void; ctx: ToolContext; task: Task;
  p: DependencyProvenance; ancestry: ReturnType<typeof gitAncestry>; head: string; input: Record<string, unknown>;
}
async function workerAction(c: ActionContext, action: string): Promise<string> {
  const { current, save, ctx, p, ancestry, head, input } = c;
  owner(current, ctx, 'worker');
  const checkpoint = { taskId: current.id, revision: current.revision + 1, commit: head, clean: true, quiescent: true };
  const pin = () => dependencyGit(ctx.cwd, ['update-ref', `refs/orca/checkpoints/${current.id}/${current.revision + 1}`, head, '0'.repeat(head.length)]);
  if (action === 'checkpoint') { await pin(); save({ ...p, checkpoint, checkpointRun: ctx.run }); return `checkpoint ${head}; usable after this worker stops`; }
  const validation = evidence(input), commands = input.commands;
  check(Array.isArray(commands) && commands.length > 0 && commands.length <= 100 && commands.every(c => typeof c === 'string' && c.trim() && c.length <= 2000), 'affected-check command list required');
  const latest = await latestDefault(ctx.cwd);
  check(await ancestry(latest.commit, head), 'update onto latest default before recording affected checks');
  await pin();
  save({ ...p, checkpoint, checkpointRun: ctx.run, checks: { head, defaultCommit: latest.commit, run: ctx.run!, commands: commands as string[], validation }, review: undefined });
  return `worker evidence recorded for ${head}; no checks executed by task tool`;
}
async function reviewAction(c: ActionContext): Promise<string> {
  const { current, save, ctx, p, head, input } = c;
  owner(current, ctx, 'reviewer', 'review');
  check(p.checks?.head === head, 'matching worker evidence required before review attestation');
  save({ ...p, review: { head, run: ctx.run!, validation: evidence(input) } }); return `code review recorded for ${head}`;

}
async function prepareAction(c: ActionContext, latest: Awaited<ReturnType<typeof latestDefault>>): Promise<string> {
  const { current, save, ctx, task, p, ancestry, head, input } = c;
  owner(current, ctx, 'worker');
  if (p.replay) await adoptedReplay(current, ctx.cwd, head);
  if ((!p.stack || p.replay) && await ancestry(latest.commit, head)) return `already contains latest default ${latest.commit}; record affected checks on this head`;
  check(p.stack && !current.pr, 'worker must update independent/published branch onto latest default without discarding user changes');
  // Repeated updates replay only the previous default..currentHead, not the old parent.
  const effective = p.replay ? { ...p.stack, baseCommit: p.replay.onto } : p.stack;
  const replay = await replayStack(ctx.cwd, task.branch, effective, latest.commit);
  const receipt = { ...replay, stack: p.stack, oldHead: p.replay?.oldHead ?? replay.oldHead };
  save({ version: 1, stack: p.stack, replay: receipt }); // durable BEFORE adoption (crash recovery)
  check(await cleanBranchHead(ctx.cwd, task.branch) === head, 'source head changed before candidate adoption');
  // --keep rejects overwriting local changes; never --hard. Original and candidate
  // refs survive. The project lock excludes other supervised writers, not user shells.
  await dependencyGit(ctx.cwd, ['reset', '--keep', receipt.newHead]);
  check(await cleanBranchHead(ctx.cwd, task.branch) === receipt.newHead, 'candidate adoption needs recovery');
  return `adopted B-only candidate ${receipt.newHead} onto ${latest.commit}; run only affected worker checks then request code review`;

}

async function publishAction(c: ActionContext, latest: Awaited<ReturnType<typeof latestDefault>>) {
  const { current, tasks, ctx, task, p, head } = c;
  owner(current, ctx, 'reviewer', 'watch-ci');
  const requireReview = !!current.dependsOn?.length || !!p.stack || (await effectiveFlow(ctx.project)).maxReviewRounds !== 0;
  await verifyPublicationState(ctx.project, ctx.cwd, current, tasks, requireReview);
  const repository = await originRepo(ctx.project); check(repository, 'GitHub origin required');
  check(await cleanBranchHead(ctx.cwd, task.branch) === head, 'head changed before publication');
  ctx.signal?.throwIfAborted();
  const pr = await publishBranch(ctx.cwd, repository, task.branch, latest.branch, head, current.pr, async () => {
    check(await originRepo(ctx.project) === repository, 'origin identity changed before remote effects');
    const fresh = await latestDefault(ctx.cwd);
    check(fresh.commit === latest.commit && fresh.branch === latest.branch, 'default changed before remote effects');
    check(await cleanBranchHead(ctx.cwd, task.branch) === head, 'head changed before remote effects');
  });
  return { ...pr, repository };
}

export const dependencyActions = ['checkpoint', 'prepare_publication', 'checks', 'reviewed', 'publish'] as const;
export async function dependencyAction(action: string, input: Record<string, unknown>, ctx: ToolContext, task: Task): Promise<string> {
  check(ctx.run && ctx.branch === task.branch, 'workflow action requires supervised own branch');
  if (['prepare_publication', 'publish'].includes(action)) {
    owner(task, ctx, action === 'publish' ? 'reviewer' : 'worker', action === 'publish' ? 'watch-ci' : undefined);
    await refreshMerges(ctx.project, task.id);
  }
  let published: { repository: string; number: number } | undefined;
  const result = await withDependencyTaskOwnership(ctx.project, task.id, task.branch, async (current, tasks, save) => {
    ctx.signal?.throwIfAborted();
    await assertRepository(ctx.project, ctx.cwd);
    const p = provenance(current) ?? { version: 1 as const }, ancestry = gitAncestry(ctx.cwd);
    const head = await cleanBranchHead(ctx.cwd, task.branch);
    const c: ActionContext = { current, tasks, save, ctx, task, p, ancestry, head, input };
    if (action === 'checkpoint' || action === 'checks') return workerAction(c, action);
    if (action === 'reviewed') return reviewAction(c);
    assertLedgerPrerequisitesMerged(tasks, current.id);
    const latest = await latestDefault(ctx.cwd);
    if (action === 'prepare_publication') return prepareAction(c, latest);
    check(action === 'publish', 'unsupported dependency action');
    const pr = await publishAction(c, latest);
    published = { repository: pr.repository, number: pr.number };
    return `published ${pr.url}`;
  }, ctx.run);
  // Do not nest project locks. Record verified publication immediately after remote
  // success; failures report partial success and next publish reconciles before create.
  if (published) {
    const observed = await ghTaskPR(ctx.project, published);
    check(observed?.state === 'OPEN', 'published remotely; task pr refresh required');
    await observeTaskPR(ctx.project, task.id, observed);
  }
  return result;
}
