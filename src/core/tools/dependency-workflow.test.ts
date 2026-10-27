import { validateTaskReadiness } from '../data/tasks';
import { saveProjectFlow } from '../data/projects';
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../config';
import { makeTaskTool } from './task';
import { makeSpawn } from './spawn';
import { ensureTaskWorktree, type Runner } from '../tmux/runner';
import { getTask, prepareTaskRun, registerTask, setTaskDependencies, startTaskRun, stopTaskRun } from '../data/tasks';
import { provenance } from '../data/tasks/dependency-provenance';
import type { ToolContext } from './registry';

const home = mkdtempSync(join(tmpdir(), 'orca-workflow-integration-'));
const old = { home: process.env.ORCA_HOME, path: process.env.PATH, state: process.env.FAKE_DEP_GH };
process.env.ORCA_HOME = home;
const realGit = Bun.which('git')!;
const bin = join(home, 'bin'); mkdirSync(bin); const stateFile = join(home, 'gh.json');
process.env.FAKE_DEP_GH = stateFile; process.env.PATH = `${bin}:${old.path}`;
// Keep the fixture's GitHub identity while all transport is rewritten to a local bare repo.
writeFileSync(join(bin, 'git'), `#!${process.execPath}
const args=process.argv.slice(2);
if(args.slice(-3).join(' ')==='remote get-url origin') console.log('https://github.com/o/r');
else { const p=Bun.spawnSync([${JSON.stringify(realGit)},...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'}); process.exit(p.exitCode); }
`); chmodSync(join(bin, 'git'), 0o700);

writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs'); const p = ${JSON.stringify(stateFile)}, s = JSON.parse(fs.readFileSync(p)), a = process.argv.slice(2);
s.calls.push(a); const save = () => fs.writeFileSync(p, JSON.stringify(s));
if (a[0] !== 'pr') process.exit(8);
if (a[1] === 'list') { save(); console.log(JSON.stringify(s.published ? [{number:2,headRefOid:s.head,state:'OPEN',url:'https://github.com/o/r/pull/2'}] : [])); }
else if (a[1] === 'create') { s.published=true; save(); if(s.failCreate) process.exit(1); console.log('https://github.com/o/r/pull/2'); }
else if (a[1] === 'view') { const n=Number(a[2]); save(); console.log(JSON.stringify({ number:n,url:'https://github.com/o/r/pull/'+n,headRefName:n===1?'a':'b',headRefOid:n===1?s.parent:s.head,state:n===1?s.parentState:'OPEN',mergedAt:n===1&&s.parentState==='MERGED'?'2026-01-01':null,isDraft:false,isCrossRepository:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'',statusCheckRollup:[] })); }
else process.exit(9);
`); chmodSync(join(bin, 'gh'), 0o700);
afterAll(() => { for (const [key, value] of Object.entries({ ORCA_HOME: old.home, PATH: old.path, FAKE_DEP_GH: old.state })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(home, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args]); if (r.exitCode) throw Error(r.stderr.toString()); return r.stdout.toString().trim();
};
const tool = makeTaskTool();
function state(patch: Record<string, unknown>) { const s = JSON.parse(readFileSync(stateFile, 'utf8')); writeFileSync(stateFile, JSON.stringify({ ...s, ...patch })); }

test('real task/spawn/runner: open parent permits local code; merged squash adopts B-only; own reviewer publishes once after checks/review', async () => {
  const project = 'e2e';
  mkdirSync(paths.project(project), { recursive: true });
  await saveProjectFlow(project, { maxReviewRounds: 0 });
  const cwd = paths.repo(project); mkdirSync(cwd, { recursive: true });
  const remote = join(home, 'remote.git'); mkdirSync(remote); git(remote, 'init', '--bare', '--initial-branch=main');
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', `url.${remote}.insteadOf`, 'https://github.com/o/r'); git(cwd, 'remote', 'add', 'origin', 'https://github.com/o/r');
  writeFileSync(join(cwd, 'main'), 'main'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'main'); git(cwd, 'push', 'origin', 'main');
  const a = await registerTask(project, { name: 'A', summary: 'parent', branch: 'a', authorized: true });
  const b = await registerTask(project, { name: 'B', summary: 'dependent', branch: 'b', authorized: true });
  await setTaskDependencies(project, b.id, [a.id]);
  let workerCwd = '';
  const runner: Runner = { running: async () => [], stop: async () => {}, start: async opts => { workerCwd = await ensureTaskWorktree(opts); await startTaskRun(project, opts.run!); } };
  const spawn = makeSpawn(runner);
  const orch: ToolContext = { project, cwd, role: 'orchestrator' };
  await spawn.run({ taskId: a.id, branch: 'a', prompt: 'parent' }, orch);
  const aRun = (await getTask(project, a.id)).runs.at(-1)!.id;
  const aCtx: ToolContext = { project, cwd: workerCwd, role: 'worker', branch: 'a', run: aRun };
  writeFileSync(join(workerCwd, 'a'), 'parent'); git(workerCwd, 'add', '.'); git(workerCwd, 'commit', '-m', 'A'); const parent = git(workerCwd, 'rev-parse', 'HEAD');
  writeFileSync(stateFile, JSON.stringify({ parent, parentState: 'OPEN', published: false, calls: [] }));
  expect(await tool.run({ action: 'checkpoint' }, { ...aCtx, run: 'competing-run' })).toContain('refused');
  expect(await tool.run({ action: 'checkpoint' }, aCtx)).toContain('checkpoint');
  const recorded = await tool.run({ action: 'pr', taskId: a.id, repository: 'o/r', number: 1 }, orch);
  if (recorded.includes('refused')) { const debug = Bun.spawnSync([join(bin, 'gh'), 'pr', 'view', '1']); throw Error(recorded + '\nwhich=' + Bun.which('gh') + '\npath=' + process.env.PATH + '\nfixture stdout: ' + debug.stdout.toString() + '\nstderr: ' + debug.stderr.toString()); }
  expect(recorded).not.toContain('refused');
  await stopTaskRun(project, aRun, 'waiting', 'complete');
  await spawn.run({ taskId: b.id, branch: 'b', baseCommit: parent, prompt: 'dependent' }, orch);
  const bRun = (await getTask(project, b.id)).runs.at(-1)!.id;
  const bCtx: ToolContext = { project, cwd: workerCwd, role: 'worker', branch: 'b', run: bRun };
  expect(git(workerCwd, 'rev-parse', 'HEAD')).toBe(parent);
  writeFileSync(join(workerCwd, 'b'), 'dependent'); git(workerCwd, 'add', '.'); git(workerCwd, 'commit', '-m', 'B'); const original = git(workerCwd, 'rev-parse', 'HEAD');
  expect(await tool.run({ action: 'publish' }, bCtx)).toContain('refused');
  expect(await tool.run({ action: 'prepare_publication' }, bCtx)).toContain('not verified merged');
  await expect(validateTaskReadiness(project, b.id, { run: bRun, revision: (await getTask(project, b.id)).revision,
    validated: true, validation: 'manual PR readiness must not bypass merge gates', observation: {
      pr: { repository: 'o/r', number: 2, url: 'https://github.com/o/r/pull/2', head: original },
      branch: 'b', state: 'OPEN', ready: true, checks: 'not_configured',
    } })).rejects.toThrow('merge is not verified');
  // Simulate the user's separately authorized parent squash merge, never a workflow auto-merge.
  git(cwd, 'merge', '--squash', 'a'); git(cwd, 'commit', '-m', 'squashed A'); git(cwd, 'push', 'origin', 'main'); state({ parentState: 'MERGED' });
  writeFileSync(join(workerCwd, 'dirty'), 'keep me');
  expect(await tool.run({ action: 'prepare_publication' }, bCtx)).toContain('dirty'); expect(readFileSync(join(workerCwd, 'dirty'), 'utf8')).toBe('keep me'); rmSync(join(workerCwd, 'dirty'));
  expect(await tool.run({ action: 'prepare_publication' }, bCtx)).toContain('adopted B-only');
  const head = git(workerCwd, 'rev-parse', 'HEAD'); state({ head, failCreate: true });
  expect(head).not.toBe(original); expect(git(workerCwd, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1');
  expect(await tool.run({ action: 'checks', commands: ['bun test affected.test.ts'], validation: 'affected tests passed; saved output fixture' }, bCtx)).toContain('worker evidence recorded');
  await stopTaskRun(project, bRun, 'waiting', 'complete');
  await spawn.run({ taskId: b.id, branch: 'b', role: 'reviewer', reviewMode: 'watch-ci', prompt: 'zero review publication' }, orch);
  const zeroRun = (await getTask(project, b.id)).runs.at(-1)!.id;
  expect(await tool.run({ action: 'publish' }, { ...bCtx, role: 'reviewer', run: zeroRun })).toContain('separate review-mode handoff required');
  await stopTaskRun(project, zeroRun, 'waiting', 'explicit handoff');
  await spawn.run({ taskId: b.id, branch: 'b', role: 'reviewer', reviewMode: 'review', prompt: 'review' }, orch);
  const reviewRun = (await getTask(project, b.id)).runs.at(-1)!.id;
  const reviewCtx: ToolContext = { project, cwd: workerCwd, role: 'reviewer', branch: 'b', run: reviewRun };
  expect(await tool.run({ action: 'publish' }, reviewCtx)).toContain('refused');
  expect(await tool.run({ action: 'reviewed', validation: 'review passed; no findings' }, reviewCtx)).toContain('code review recorded');
  await stopTaskRun(project, reviewRun, 'waiting', 'complete');
  // Recreating a stopped worker's checkout must use replay provenance, not the old parent.
  git(cwd, 'worktree', 'remove', workerCwd);
  await spawn.run({ taskId: b.id, branch: 'b', role: 'reviewer', reviewMode: 'watch-ci', prompt: 'publish and watch CI' }, orch);
  const watchRun = (await getTask(project, b.id)).runs.at(-1)!.id;
  const watchCtx: ToolContext = { ...reviewCtx, run: watchRun };
  expect(await tool.run({ action: 'publish' }, watchCtx)).toContain('published https://github.com/o/r/pull/2');
  expect(await tool.run({ action: 'publish' }, watchCtx)).toContain('published https://github.com/o/r/pull/2');
  const calls = JSON.parse(readFileSync(stateFile, 'utf8')).calls as string[][];
  expect(calls.filter(a => a[1] === 'create')).toHaveLength(1);
  expect((await getTask(project, b.id)).publication?.state).toBe('OPEN');
  expect(provenance(await getTask(project, b.id))!.review!.head).toBe(head);
});
