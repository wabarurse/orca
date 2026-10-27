import { check, sha } from '../../../protocol/tasks';
import type { Ancestor } from './dependency-policy';

/** Read immutable git objects in this checkout only, never another worker's worktree.
 * No shell, ref guessing, fetching, merge, rebase, checkout, or user-work mutation.
 * Caller refreshes default explicitly and records its resolved immutable object ID.
 */
export function gitAncestry(cwd: string): Ancestor {
  return async (ancestor, descendant) => {
    check(sha(ancestor) && sha(descendant), 'ancestry requires immutable commits');
    async function git(args: string[]): Promise<number> {
      const child = Bun.spawn(['git', '-C', cwd, ...args], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
      });
      const timer = setTimeout(() => child.kill(), 10_000);
      try { return await child.exited; } finally { clearTimeout(timer); }
    }
    // Require commit-resolving objects even when the supplied SHA is syntactically valid.
    for (const object of new Set([ancestor, descendant])) {
      check(await git(['cat-file', '-e', `${object}^{commit}`]) === 0, 'commit object unavailable');
    }
    const code = await git(['merge-base', '--is-ancestor', ancestor, descendant]);
    check(code === 0 || code === 1, 'ancestry could not be verified');
    return code === 0;
  };
}
