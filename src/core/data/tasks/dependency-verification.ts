/** Shared runtime gate for publication AND readiness. Caller holds the project lock. */
import { realpath } from 'node:fs/promises';
import { paths } from '../../../config';
import { check, type Task } from '../../../protocol/tasks';
import { provenance } from './dependency-provenance';
import { assertPublication } from './dependency-policy';
import { ledgerDependencies } from './dependency-ledger';
import { cleanBranchHead, dependencyGit } from './dependency-replay';
import { gitAncestry } from './dependency-git';
import { latestDefault } from './dependency-remote';

export async function assertRepository(project: string, cwd: string): Promise<void> {
  const common = async (dir: string) => realpath(await dependencyGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  check(await common(cwd) === await common(paths.repo(project)), 'dependency checkout belongs to another repository');
}
export async function adoptedReplay(task: Task, cwd: string, head: string) {
  const p = provenance(task);
  if (!p?.stack) return undefined;
  const replay = p.replay;
  check(replay, 'prepare_publication required: missing B-only replay receipt');
  const candidate = await dependencyGit(cwd, ['rev-parse', '--verify', `${replay.protectedRef}/candidate`]);
  check(candidate === replay.newHead, 'replay candidate ref mismatch');
  check(await gitAncestry(cwd)(candidate, head), 'prepared replay not adopted; manual recovery required before retry');
  return { ...replay, newHead: head };
}
export async function verifyPublicationState(project: string, cwd: string, task: Task, tasks: readonly Task[], requireReview = true) {
  await assertRepository(project, cwd);
  const head = await cleanBranchHead(cwd, task.branch), p = provenance(task);
  check(p?.checks, 'worker checks evidence required');
  check(!requireReview || p.review, 'separate review-mode handoff required for dependent publication even with zero review rounds; record reviewed on updated head');
  const latest = await latestDefault(cwd), update = await adoptedReplay(task, cwd, head);
  await assertPublication(ledgerDependencies(tasks), { taskId: task.id, head, defaultCommit: latest.commit,
    clean: true, workerEvidence: p.checks, reviewedHead: p.review?.head, requireReview, update }, gitAncestry(cwd), p.stack);
  check(await cleanBranchHead(cwd, task.branch) === head, 'head changed during verification');
  return { head, latest };
}
