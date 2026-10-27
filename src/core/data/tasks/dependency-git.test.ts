import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitAncestry } from './dependency-git';
test('immutable ancestry uses only local commit objects and fails closed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-dependency-git-'));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...process.env,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (p.exitCode) throw new Error(p.stderr.toString()); return p.stdout.toString().trim();
  };
  try {
    git('init'); git('commit', '--allow-empty', '-m', 'default'); const first = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-m', 'checkpoint'); const next = git('rev-parse', 'HEAD');
    const ancestor = gitAncestry(cwd);
    expect(await ancestor(first, next)).toBe(true); expect(await ancestor(next, first)).toBe(false);
    await expect(ancestor('HEAD', next)).rejects.toThrow('immutable');
    await expect(ancestor('f'.repeat(40), next)).rejects.toThrow('unavailable');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
