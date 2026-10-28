import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths } from '../../../config';
import { registerTask, getTask, setTaskDependencies, observeTaskPR, withDependencyTaskOwnership, prepareTaskRun } from './tasks';
import { captureDependencyCheckpoint, recordDependencyStack, prepareDependencyReplay, coordinateDependencyPublication } from './dependency-coordinator';
import { provenance } from './dependency-provenance';
import { replayStack } from './dependency-replay';
const home = mkdtempSync(join(tmpdir(), 'orca-dependency-runtime-'));
const previous = process.env.ORCA_HOME; process.env.ORCA_HOME = home;
afterAll(() => { if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous; rmSync(home, { recursive: true, force: true }); });
let n = 0;
function repo() {
  const project = `dependency-${++n}`; mkdirSync(paths.project(project), { recursive: true });
  const cwd = paths.repo(project); mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args]); if (p.exitCode) throw Error(p.stderr.toString()); return p.stdout.toString().trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(cwd, 'base'), 'base'); git('add', '.'); git('commit', '-m', 'default');
  const base = git('rev-parse', 'HEAD');
  return { project, cwd, git, base };
}
async function fixture(transitive = false) {
  const r = repo(), { project, cwd, git } = r;
  const a = await registerTask(project, { name: 'A', summary: 'parent', branch: 'a', authorized: true });
  const b = await registerTask(project, { name: 'B', summary: 'child', branch: 'b', authorized: true });
  await setTaskDependencies(project, b.id, [a.id]);
  const c = transitive ? await registerTask(project, { name: 'C', summary: 'transitive', branch: 'c', authorized: true }) : undefined;
  if (c) { await setTaskDependencies(project, a.id, [c.id]); }
  git('checkout', '-b', 'a'); writeFileSync(join(cwd, 'a'), 'parent'); git('add', '.'); git('commit', '-m', 'A');
  if (c) { git('checkout', '-b', 'c'); await captureDependencyCheckpoint(project, c.id, 'c', cwd); git('checkout', 'a'); }
  const checkpoint = await captureDependencyCheckpoint(project, a.id, 'a', cwd);
  const authority = { authorized: new Set([a.id, b.id]), requirements: new Map([[a.id, 'satisfied' as const], [b.id, 'satisfied' as const]]) };
  if (c) { authority.authorized.add(c.id); authority.requirements.set(c.id, 'satisfied'); }
  const stack = await recordDependencyStack(project, b.id, 'b', cwd, r.base, checkpoint.commit, authority);
  git('checkout', '-b', 'b'); writeFileSync(join(cwd, 'b'), 'child'); git('add', '.'); git('commit', '-m', 'B');
  const oldHead = git('rev-parse', 'HEAD');
  return { ...r, a, b, authority, stack, oldHead };
}
test('ledger stores trusted clean checkpoint and immutable stack; active writers are rejected', async () => {
  const { project, cwd, a, b, stack } = await fixture();
  expect(provenance(await getTask(project, b.id))!.stack).toEqual(stack);
  const parent = await getTask(project, a.id); expect(provenance(parent)!.checkpoint!.revision).toBe(parent.revision);
  await prepareTaskRun(project, b.id, b.branch, { id: 'writer', agent: 'worker-b', role: 'worker' });
  await expect(captureDependencyCheckpoint(project, b.id, 'b', cwd)).rejects.toThrow('quiescent');
});
test('B-only replay after squash keeps source untouched and persists protected receipt; publication uses stored receipt', async () => {
  const { project, cwd, git, a, b, authority, oldHead } = await fixture();
  await expect(prepareDependencyReplay(project, b.id, 'b', cwd, oldHead, authority)).rejects.toThrow('merge is not verified');
  git('checkout', 'main'); git('merge', '--squash', 'a'); git('commit', '-m', 'squashed A'); const onto = git('rev-parse', 'HEAD'); git('checkout', 'b');
  await observeTaskPR(project, a.id, { pr: { repository: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1', head: git('rev-parse', 'a') }, branch: 'a', state: 'MERGED', mergedAt: '2026-01-01', checks: 'unknown', ready: false });
  const receipt = await prepareDependencyReplay(project, b.id, 'b', cwd, onto, authority);
  expect(git('rev-parse', 'HEAD')).toBe(oldHead); expect(readFileSync(join(cwd, 'b'), 'utf8')).toBe('child');
  expect(git('rev-list', '--count', `${onto}..${receipt.newHead}`)).toBe('1');
  expect(git('show', `${receipt.newHead}:a`)).toBe('parent');
  expect(provenance(await getTask(project, b.id))!.replay).toEqual(receipt);
  let published = false;
  // Candidate has not been explicitly adopted: source must not publish.
  await expect(coordinateDependencyPublication(project, b.id, 'b', cwd, async () => ({ authority, state: {
    taskId: b.id, head: oldHead, defaultCommit: onto, clean: true, reviewedHead: oldHead,
    workerEvidence: { head: oldHead, defaultCommit: onto, commands: ['affected test'] },
  } }), async () => { published = true; })).rejects.toThrow('candidate');
  expect(published).toBe(false);
});
test('conflict fails without modifying user branch or files', async () => {
  const { cwd, git, stack, oldHead } = await fixture();
  git('checkout', 'main'); writeFileSync(join(cwd, 'b'), 'conflict'); git('add', '.'); git('commit', '-m', 'conflict'); const onto = git('rev-parse', 'HEAD'); git('checkout', 'b');
  await expect(replayStack(cwd, 'b', stack, onto)).rejects.toThrow('cherry-pick');
  expect(git('rev-parse', 'HEAD')).toBe(oldHead); expect(git('status', '--porcelain')).toBe('');
  expect(readFileSync(join(cwd, 'b'), 'utf8')).toBe('child');
});
test('publication dependencies include transitive prerequisites and ownership serializes task launches', async () => {
  const { project, cwd, a, b, authority, oldHead } = await fixture(true);
  await observeTaskPR(project, a.id, { pr: { repository: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1', head: oldHead }, branch: 'a', state: 'MERGED', mergedAt: '2026-01-01', checks: 'unknown', ready: false });
  let published = false;
  await expect(coordinateDependencyPublication(project, b.id, 'b', cwd, async () => ({ authority, state: {
    taskId: b.id, head: oldHead, defaultCommit: oldHead, clean: true, reviewedHead: oldHead,
    workerEvidence: { head: oldHead, defaultCommit: oldHead, commands: ['affected test'] },
  } }), async () => { published = true; })).rejects.toThrow('merge is not verified');
  expect(published).toBe(false);
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const operation = withDependencyTaskOwnership(project, b.id, 'b', async () => { entered(); await wait; });
  await ready; let launched = false;
  const launch = prepareTaskRun(project, b.id, 'b', { id: 'later', agent: 'worker-b', role: 'worker' }).then(() => { launched = true; });
  await Bun.sleep(20); expect(launched).toBe(false); release(); await operation; await launch; expect(launched).toBe(true);
});

test('recorded stack edges cannot be cleared to bypass prerequisite merge gates', async () => {
  const { project, a, b } = await fixture();
  await expect(setTaskDependencies(project, b.id, [])).rejects.toThrow('immutable');
  await expect(setTaskDependencies(project, a.id, [b.id])).rejects.toThrow();
  expect((await setTaskDependencies(project, b.id, [a.id])).dependsOn).toEqual([a.id]);
});

test('slow dependency work holds only the dependency lock: project state stays writable, and a task change meanwhile refuses the save', async () => {
  const { project, b } = await fixture();
  const before = provenance(await getTask(project, b.id));
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const operation = withDependencyTaskOwnership(project, b.id, 'b', async (task, _tasks, save) => {
    entered(); await wait; // stands for git status/fetch/push and gh calls
    await save({ ...provenance(task), version: 1 });
  });
  await ready;
  // Not queued behind the operation (it previously held the project state lock throughout).
  await observeTaskPR(project, b.id, { pr: { repository: 'o/r', number: 7, url: 'https://github.com/o/r/pull/7', head: 'd'.repeat(40) }, branch: 'b', state: 'OPEN', ready: false, checks: 'pending' });
  expect((await getTask(project, b.id)).pr?.number).toBe(7);
  release();
  await expect(operation).rejects.toThrow('dependency task changed');
  expect(provenance(await getTask(project, b.id))).toEqual(before);
});
