/** Bounded argv-only remote operations for the supported task publication path. */
import { check, sha } from "../../../protocol/task";
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
interface RemotePR { number: number; state: string; html_url: string; head: { ref: string; sha: string; repo: { full_name: string } }; base: { ref: string; repo: { full_name: string } } }
function exactPR(pr: RemotePR, repository: string, branch: string, base: string, number: number): PublishedPR {
  check(pr.number === number && pr.state === 'open', 'PR identity/state mismatch');
  check(pr.head?.repo?.full_name === repository && pr.head.ref === branch, 'PR head repository/branch mismatch');
  check(pr.base?.repo?.full_name === repository && pr.base.ref === base, 'PR base repository/branch mismatch');
  check(sha(pr.head.sha), 'invalid PR head commit');
  check(pr.html_url === `https://github.com/${repository}/pull/${number}`, 'PR URL mismatch');
  return { number, state: 'OPEN', headRefOid: pr.head.sha, url: pr.html_url };
}
export async function publishBranch(cwd: string, repository: string, branch: string, base: string, head: string,
  recorded?: { repository: string; number: number }, beforeEffects: () => Promise<void> = async () => {}): Promise<PublishedPR> {
  check(!recorded || recorded.repository === repository, 'recorded PR repository mismatch');
  const lookup = async () => {
    const rows: { number: number }[] = JSON.parse(await dependencyGh(cwd,
      ['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--json', 'number']));
    check(rows.length <= 1, 'ambiguous branch PRs require explicit reconciliation');
    if (!rows.length) { check(!recorded, 'recorded PR missing from branch'); return undefined; }
    const number = rows[0]!.number;
    check(Number.isSafeInteger(number) && number > 0, 'invalid PR number');
    check(!recorded || recorded.number === number, 'recorded PR number mismatch');
    const pr = JSON.parse(await dependencyGh(cwd, ['api', `repos/${repository}/pulls/${number}`]));
    return exactPR(pr, repository, branch, base, number);
  };
  const before = await lookup();
  // Identity and latest-default revalidation occur before any remote write.
  await beforeEffects();
  await dependencyGit(cwd, ['push', '--porcelain', 'origin', `${head}:refs/heads/${branch}`]);
  if (!before) {
    await beforeEffects();
    try { await dependencyGh(cwd, ['pr', 'create', '--repo', repository, '--head', branch, '--base', base, '--fill-first']); }
    catch (error) {
      const after = await lookup();
      if (!after || after.headRefOid !== head) throw error;
      return after;
    }
  }
  const after = await lookup();
  check(after?.headRefOid === head, 'push/create needs reconciliation; PR head not confirmed');
  return after;
}
