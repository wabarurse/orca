/** Bounded argv-only remote operations for the supported task publication path. */
import { check } from '../../../protocol/tasks';
import { dependencyGit } from './dependency-replay';
import { run } from '../../proc';
export async function dependencyGh(cwd: string, args: string[]): Promise<string> {
  const result = await run(['gh', ...args], { cwd, timeoutMs: 20_000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' } });
  check(result?.code === 0, `gh ${args[0]} failed: ${result?.out ?? 'unavailable/timed out'}`); return result.out.trim();
}
export async function latestDefault(cwd: string): Promise<{ branch: string; commit: string }> {
  // Ask origin, not local HEAD or a guessed main/master branch. ls-remote performs
  // no local checkout changes. Fetch the exact advertised default branch explicitly.
  const remote = await dependencyGit(cwd, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(remote)?.[1];
  check(branch, 'origin default branch unavailable');
  await dependencyGit(cwd, ['check-ref-format', `refs/heads/${branch}`]);
  await dependencyGit(cwd, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const commit = await dependencyGit(cwd, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
  return { branch, commit };
}
export interface PublishedPR { number: number; headRefOid: string; state: string; url: string }
export async function publishBranch(cwd: string, repository: string, branch: string, base: string, head: string): Promise<PublishedPR> {
  const list = async (): Promise<PublishedPR[]> => JSON.parse(await dependencyGh(cwd,
    ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--json', 'number,headRefOid,state,url']));
  const before = await list(); check(before.length <= 1, 'ambiguous branch PRs require explicit reconciliation');
  check(!before[0] || before[0].state === 'OPEN', 'branch PR is closed/merged; publication refused');
  // No force push: concurrent or rewritten remote work must be reconciled explicitly.
  await dependencyGit(cwd, ['push', '--porcelain', 'origin', `${head}:refs/heads/${branch}`]);
  if (!before.length) {
    try { await dependencyGh(cwd, ['pr', 'create', '--repo', repository, '--head', branch, '--base', base, '--fill-first']); }
    catch (error) {
      // A timeout may follow a successful remote create. Query once, never blindly
      // create twice. If no verified open PR exists, report partial push and retry later.
      const after = await list();
      if (after.length !== 1 || after[0]!.state !== 'OPEN' || after[0]!.headRefOid !== head) throw error;
      return after[0]!;
    }
  }
  const after = await list();
  check(after.length === 1 && after[0]!.state === 'OPEN' && after[0]!.headRefOid === head, 'push/create needs reconciliation; PR head not confirmed');
  return after[0]!;
}
