import { describe, expect, test } from 'bun:test';
import type { Task } from '../../../protocol/tasks';
import { assertPublication, dependencyClosure, gatedPublication, resolveStackBase, type DependencySnapshot, type PublicationState } from './dependency-policy';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (n: number) => String(n).repeat(40);
const task = (n: number, deps: number[] = []): Task => ({ id: id(n), name: 'task', summary: 'work', branch: `b${n}`,
  status: 'queued', createdAt: '', updatedAt: '', revision: 1, runs: [], history: [], dependsOn: deps.map(id) });
function fixture() {
  const a = task(1), b = task(2, [1]);
  const snapshot: DependencySnapshot = { tasks: [a, b], authorized: new Set([a.id, b.id]),
    checkpoints: [{ taskId: a.id, revision: 1, commit: hash(2), clean: true, quiescent: true }],
    requirements: new Map([[a.id, 'satisfied'], [b.id, 'satisfied']]) };
  const state: PublicationState = { taskId: b.id, head: hash(3), defaultCommit: hash(1), clean: true,
    workerEvidence: { head: hash(3), defaultCommit: hash(1), commands: ['bun test affected.test.ts'] }, reviewedHead: hash(3) };
  return { a, b, snapshot, state };
}
function merged(t: Task) {
  t.pr = { repository: 'owner/repo', number: 1, url: 'https://github.com/owner/repo/pull/1', head: hash(2) };
  t.archive = { reason: 'merged', mergedAt: '2026-01-01', archivedAt: '2026-01-01', pr: t.pr };
}
const ancestor = async (a: string, b: string) => Number(a[0]) <= Number(b[0]);
describe('explicit dependency preparation', () => {
  test('open clean immutable checkpoint permits local preparation, not publication', async () => {
    const { snapshot, state } = fixture();
    const base = await resolveStackBase(snapshot, state.taskId, hash(1), hash(2), ancestor);
    expect(base.baseCommit).toBe(hash(2)); expect(base.prerequisites[0]!.taskId).toBe(id(1));
    let published = false;
    await expect(gatedPublication(async () => ({ snapshot, state }), ancestor, async () => { published = true; })).rejects.toThrow('merge is not verified');
    expect(published).toBe(false);
  });
  for (const mode of ['missing', 'cycle', 'unauthorized', 'cancelled', 'blocked', 'requirement'] as const) {
    test(`${mode} fails closed`, () => {
      const { a, b, snapshot } = fixture();
      if (mode === 'missing') b.dependsOn = [id(9)];
      if (mode === 'cycle') a.dependsOn = [b.id];
      if (mode === 'unauthorized') (snapshot.authorized as Set<string>).delete(a.id);
      if (mode === 'cancelled' || mode === 'blocked') a.attention = { kind: mode, reason: 'stop' };
      if (mode === 'requirement') (snapshot.requirements as Map<string, string>).set(a.id, 'pending');
      expect(() => dependencyClosure(snapshot, b.id)).toThrow();
    });
  }
  for (const mode of ['dirty', 'active', 'stale', 'missing', 'ambiguous'] as const) {
    test(`${mode} checkpoint is unusable`, async () => {
      const { a, b, snapshot } = fixture(); const c = snapshot.checkpoints[0]!;
      if (mode === 'dirty') c.clean = false;
      if (mode === 'active') c.quiescent = false;
      if (mode === 'stale') c.revision++;
      if (mode === 'missing') snapshot.checkpoints = [];
      if (mode === 'ambiguous') snapshot.checkpoints = [c, c];
      await expect(resolveStackBase(snapshot, b.id, hash(1), hash(2), ancestor)).rejects.toThrow();
    });
  }
  test('multiple dependencies require all code, never choose a common ancestor or unproven composition', async () => {
    const { b, snapshot } = fixture(); const c = task(3); b.dependsOn!.push(c.id);
    snapshot.tasks = [...snapshot.tasks, c]; (snapshot.authorized as Set<string>).add(c.id);
    (snapshot.requirements as Map<string, string>).set(c.id, 'satisfied');
    snapshot.checkpoints = [...snapshot.checkpoints, { taskId: c.id, revision: 1, commit: hash(4), clean: true, quiescent: true }];
    await expect(resolveStackBase(snapshot, b.id, hash(1), hash(2), ancestor)).rejects.toThrow('omits');
    await expect(resolveStackBase(snapshot, b.id, hash(1), hash(5), ancestor)).rejects.toThrow('unproven');
    expect((await resolveStackBase(snapshot, b.id, hash(1), hash(4), ancestor)).prerequisites).toHaveLength(2);
  });
});
describe('publication after verified merges', () => {
  test('all gates precede supported publication callback', async () => {
    const { a, snapshot, state } = fixture(); merged(a);
    expect(await gatedPublication(async () => ({ snapshot, state }), ancestor, async () => 'published')).toBe('published');
  });
  for (const mode of ['dirty', 'stale-check', 'stale-review', 'old-default', 'unknown-merge'] as const) {
    test(`${mode} blocks publication`, async () => {
      const { a, snapshot, state } = fixture(); merged(a);
      if (mode === 'dirty') state.clean = false;
      if (mode === 'stale-check') state.workerEvidence.head = hash(2);
      if (mode === 'stale-review') state.reviewedHead = hash(2);
      if (mode === 'old-default') state.defaultCommit = hash(4);
      if (mode === 'unknown-merge') a.archive!.mergedAt = 'unknown';
      await expect(assertPublication(snapshot, state, ancestor)).rejects.toThrow();
    });
  }
  test('squash/rebase parent history requires recorded base and B-only replay receipt', async () => {
    const { a, b, snapshot, state } = fixture();
    const stack = await resolveStackBase(snapshot, b.id, hash(1), hash(2), ancestor); merged(a);
    await expect(assertPublication(snapshot, state, ancestor, stack)).rejects.toThrow('replay receipt');
    state.update = { stack, oldHead: hash(3), newHead: state.head, onto: state.defaultCommit, isolatedReplay: true };
    await assertPublication(snapshot, state, ancestor, stack);
    state.update.isolatedReplay = false;
    await expect(assertPublication(snapshot, state, ancestor, stack)).rejects.toThrow('replay receipt');
  });
});
