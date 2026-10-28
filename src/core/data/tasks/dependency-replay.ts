/** Isolated B-only replay. Never checks out, resets or rebases the user's branch. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, sha } from "../../../protocol/task";
import { gitAncestry } from './dependency-git';
import type { StackBase } from './dependency-policy';

export async function dependencyGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', cwd, ...args], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
  });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    check(code === 0, `dependency git ${args[0]} failed: ${err.slice(0, 2000)}`); return out.trim();
  } finally { clearTimeout(timer); }
}
export interface ReplayReceipt {
  stack: StackBase; oldHead: string; newHead: string; onto: string; isolatedReplay: true;
  protectedRef: string; createdAt: string;
}
export async function cleanBranchHead(cwd: string, branch: string): Promise<string> {
  check(await dependencyGit(cwd, ['symbolic-ref', '--short', 'HEAD']) === branch, 'checkout branch mismatch');
  check(!await dependencyGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']), 'checkout is dirty');
  const head = await dependencyGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  check(sha(head), 'invalid checkout head'); return head;
}

/** Requires external exclusive ownership. Receipt is constructed from git results, never
 * accepted from a model. Caller durably saves it before offering the candidate for review.
 * No automatic adoption: source branch/worktree remain byte-for-byte unchanged.
 */
export async function replayStack(cwd: string, branch: string, stack: StackBase, onto: string): Promise<ReplayReceipt> {
  check(sha(onto) && sha(stack.baseCommit), 'immutable replay commits required');
  const oldHead = await cleanBranchHead(cwd, branch), ancestor = gitAncestry(cwd);
  check(await ancestor(stack.baseCommit, oldHead), 'stack base is not ancestor of dependent head');
  check(!await dependencyGit(cwd, ['rev-list', '--merges', `${stack.baseCommit}..${oldHead}`]), 'merge commits require manual replay');
  const commits = (await dependencyGit(cwd, ['rev-list', '--reverse', `${stack.baseCommit}..${oldHead}`])).split('\n').filter(Boolean);
  check(commits.length > 0, 'no dependent changes to replay');
  const protectedRef = `refs/orca/dependency-replays/${crypto.randomUUID()}`;
  // Protect original head from GC and concurrent ref replacement; no user branch change.
  await dependencyGit(cwd, ['update-ref', `${protectedRef}/original`, oldHead, '0'.repeat(oldHead.length)]);
  const scratch = await mkdtemp(join(tmpdir(), 'orca-dependency-replay-'));
  try {
    await dependencyGit(scratch, ['clone', '--shared', '--no-checkout', '--', cwd, scratch]);
    await dependencyGit(scratch, ['checkout', '--detach', onto]);
    const name = await dependencyGit(cwd, ['var', 'GIT_COMMITTER_IDENT']);
    const identity = /^(.*) <([^>]+)> /.exec(name); check(identity, 'committer identity unavailable');
    await dependencyGit(scratch, ['config', 'user.name', identity[1]!]);
    await dependencyGit(scratch, ['config', 'user.email', identity[2]!]);
    for (const commit of commits) await dependencyGit(scratch, ['cherry-pick', commit]);
    const newHead = await dependencyGit(scratch, ['rev-parse', 'HEAD']);
    check(sha(newHead), 'invalid replay head');
    // Ref import only. No checkout, reset, or working-branch update.
    await dependencyGit(cwd, ['fetch', '--no-tags', '--no-write-fetch-head', '--', scratch, `${newHead}:${protectedRef}/candidate`]);
    check(await cleanBranchHead(cwd, branch) === oldHead, 'source changed during replay; candidate not approved');
    return { stack: structuredClone(stack), oldHead, newHead, onto, isolatedReplay: true, protectedRef, createdAt: new Date().toISOString() };
  } finally {
    await rm(scratch, { recursive: true, force: true });
    // Pins intentionally survive failure for recovery; never remove a user's ref.
  }
}
