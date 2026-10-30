import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { read, write, edit } from './files';
import { launchProcess, readProcess, processOutput, listProcesses, liveProcess, controlProcess } from '../data/processes';
import { consume, pending } from '../data/inbox';
import { open } from '../data/transcripts';
import { paths } from '../../config';
import { cliCommand } from '../tmux';
import { facts, remember, selectedKnowledge, recordCorrection, workingContext } from '../data/knowledge';
import { message } from './message';
import type { ToolContext } from './registry';
import { materializeImages } from '../data/images';
import { png } from '../../test/image-fixture';

let home: string, cwd: string, ctx: ToolContext, previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ORCA_HOME;
  home = await mkdtemp(join(tmpdir(), 'orca-adaptive-')); process.env.ORCA_HOME = home;
  cwd = join(home, 'workspace'); await mkdir(cwd); await mkdir(paths.project('test'), { recursive: true });
  ctx = { project: 'test', role: 'worker', branch: 'work', cwd, run: crypto.randomUUID() };
});
afterEach(async () => {
  for (const p of await listProcesses('test')) if (liveProcess(p)) await controlProcess('test', p.id, 'stop').catch(() => {});
  await Bun.sleep(100);
  if (previous === undefined) delete process.env.ORCA_HOME; else process.env.ORCA_HOME = previous;
  await rm(home, { recursive: true, force: true });
});
async function settled(id: string) {
  for (let i = 0; i < 120; i++) { const p = await readProcess('test', id); if (!liveProcess(p) && p.events.every(e => e.delivered)) return p; await Bun.sleep(25); }
  throw new Error('process did not settle');
}
function record(command: string, timeoutMs = 2000) {
  const at = new Date().toISOString();
  return { id: crypto.randomUUID(), project: 'test', owner: 'worker-work', role: 'worker' as const, branch: 'work', run: ctx.run,
    cwd, command, createdAt: at, updatedAt: at, state: 'starting' as const, timeoutMs, maxBytes: 4096, notify: true, events: [] };
}
test('read/edit/write preserve newer content, reject ambiguous edits and create collisions', async () => {
  await write.run({ path: 'sample.txt', content: 'one\ntwo\n' }, ctx);
  const initial = JSON.parse(await read.run({ path: 'sample.txt', lines: 1 }, ctx) as string);
  expect(initial.next_line).toBe(2);
  await edit.run({ path: 'sample.txt', expected_revision: initial.revision, old_text: 'two', new_text: 'three' }, ctx);
  await expect(edit.run({ path: 'sample.txt', expected_revision: initial.revision, old_text: 'one', new_text: 'lost' }, ctx)).rejects.toThrow('changed');
  await expect(write.run({ path: 'sample.txt', content: 'lost' }, ctx)).rejects.toThrow('exists');
  expect(await readFile(join(cwd, 'sample.txt'), 'utf8')).toBe('one\nthree\n');
  const now = JSON.parse(await read.run({ path: 'sample.txt' }, ctx) as string);
  await expect(edit.run({ path: 'sample.txt', expected_revision: now.revision, old_text: '\n', new_text: '' }, ctx)).rejects.toThrow('exactly one');
});
test('write on an existing file names its current revision; retrying with it replaces, a stale one never does', async () => {
  await write.run({ path: 'exists.txt', content: 'first\n' }, ctx);
  const current = JSON.parse(await read.run({ path: 'exists.txt' }, ctx) as string).revision;
  const refusal = await write.run({ path: 'exists.txt', content: 'second\n' }, ctx).then(() => '', (e: Error) => e.message);
  expect(refusal).toContain(`expected_revision "${current}"`);
  expect(refusal).toContain('edit');
  expect(await readFile(join(cwd, 'exists.txt'), 'utf8')).toBe('first\n');
  await write.run({ path: 'exists.txt', content: 'second\n', expected_revision: current }, ctx);
  expect(await readFile(join(cwd, 'exists.txt'), 'utf8')).toBe('second\n');
  await expect(write.run({ path: 'exists.txt', content: 'third\n', expected_revision: current }, ctx)).rejects.toThrow('changed');
  expect(await readFile(join(cwd, 'exists.txt'), 'utf8')).toBe('second\n');
});
test('read returns an image file as a scoped image block, sniffed by bytes not name, and names other binaries', async () => {
  await writeFile(join(cwd, 'shot.dat'), png(3, 2));
  const result = await read.run({ path: 'shot.dat' }, ctx);
  if (!Array.isArray(result)) throw new Error('expected image content');
  const [meta, image] = result;
  if (meta?.type !== 'text' || image?.type !== 'image' || image.source.type !== 'url') throw new Error('expected text then a scoped image');
  expect(JSON.parse(meta.text)).toMatchObject({ type: 'image/png', width: 3, height: 2, bytes: png(3, 2).length });
  expect(image.source.url).toContain(JSON.parse(meta.text).attachment_id);
  expect(JSON.stringify(result)).not.toContain(png(3, 2).toString('base64')); // the transcript holds a reference, never bytes
  const [delivered] = await materializeImages('test', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: result }] }]);
  expect(JSON.stringify(delivered)).toContain(png(3, 2).toString('base64'));
  await writeFile(join(cwd, 'huge.png'), png(4097, 1));
  await expect(read.run({ path: 'huge.png' }, ctx)).rejects.toThrow('sips -Z 1568');
  await writeFile(join(cwd, 'paper.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 0xff, 0xfe])]));
  await expect(read.run({ path: 'paper.pdf' }, ctx)).rejects.toThrow('binary file (pdf); use a command such as `pdftotext');
  await expect(write.run({ path: 'shot.dat', content: 'x', expected_revision: JSON.parse(meta.text).revision }, ctx)).rejects.toThrow('png image');
  // A text file that merely starts like an image stays text; an image extension on real binary bytes decides the other way.
  await writeFile(join(cwd, 'notes.txt'), 'GIF89a is the magic string of GIF images\nsecond line\n');
  expect(JSON.parse(await read.run({ path: 'notes.txt' }, ctx) as string)).toMatchObject({ total_lines: 3, next_line: null });
  await writeFile(join(cwd, 'shot.gif'), 'GIF89a is text but named like an image\n');
  await expect(read.run({ path: 'shot.gif' }, ctx)).rejects.toThrow('gif image dimensions exceed'); // " i" read little-endian as a 26912 px width
});
test('file tools retain path boundaries across assignment presets', async () => {
  await writeFile(join(home, 'outside'), 'secret'); await symlink(join(home, 'outside'), join(cwd, 'link'));
  await expect(read.run({ path: 'link' }, ctx)).rejects.toThrow('symlink');
  await expect(write.run({ path: '../outside', content: 'lost' }, ctx)).rejects.toThrow('outside');
  await write.run({ path: 'review.txt', content: 'authorized by brief' }, { ...ctx, role: 'reviewer' });
  expect(await Bun.file(join(cwd, 'review.txt')).text()).toBe('authorized by brief');
});
test('background command yields and delivers one durable completion consumed once', async () => {
  const p = record('sleep 0.1; printf finished');
  const result = await launchProcess(p, cliCommand(), 0);
  expect(['starting', 'running']).toContain(result.state);
  const final = await settled(p.id); expect(final.exitCode).toBe(0); expect(final.state).toBe('exited');
  expect((await processOutput('test', p.id)).content).toBe('finished');
  const t = open(paths.transcript('test', p.owner)); let deliveries = 0;
  await consume('test', p.owner, t, async inbox => { deliveries += inbox.length; await t.append({ type: 'message', inbox, message: { role: 'user', content: 'process completed' } }); });
  expect(deliveries).toBe(1); expect(await pending('test', p.owner)).toBe(false);
  const { deliverProcessEvents } = await import('../data/processes');
  final.events[0]!.delivered = false; await deliverProcessEvents(final);
  await consume('test', p.owner, t, async inbox => { deliveries += inbox.length; });
  expect(deliveries).toBe(1);
});
test('background timeout preserves failed outcome and bounded output', async () => {
  const p = record('printf before; sleep 5', 150);
  await launchProcess(p, cliCommand(), 0);
  const final = await settled(p.id); expect(final.state).toBe('timed_out');
  expect((await processOutput('test', p.id)).content).toBe('before');
});
test('personal knowledge retrieval is scoped and forgetting removes future retrieval', async () => {
  await remember('test', 'user', { key: 'always.style', text: 'Keep replies concise', source: 'user-1', confidence: 'explicit', project: 'test', updatedAt: new Date().toISOString() });
  await remember('test', 'project', { key: 'database', text: 'Use SQLite', source: 'tool-1', confidence: 'tentative', project: 'test', updatedAt: new Date().toISOString() });
  expect(await selectedKnowledge('other', 'database')).not.toContain('SQLite');
  expect(await selectedKnowledge('test', 'database')).toContain('SQLite');
  await remember('test', 'user', { key: 'always.style' }); expect(await facts('test', 'user')).toEqual([]);
  await recordCorrection('test', { id: 'user-2', text: 'Change the preview, preserve the branch', at: 'now' });
  expect((await workingContext('test')).latest?.[0]?.text).toContain('preserve the branch');
});
test('long worker reports preserve full evidence while delivering a concise summary', async () => {
  const full = 'detailed evidence\n'.repeat(1000);
  await expect(message.run({ to: 'orchestrator', text: full }, ctx)).rejects.toThrow('summary');
  await message.run({ to: 'orchestrator', text: full, summary: 'Build failed; one decision required.' }, ctx);
  const t = open(paths.transcript('test', 'orchestrator'));
  await consume('test', 'orchestrator', t, async inbox => {
    expect(inbox[0]!.text.length).toBeLessThan(500);
    const path = inbox[0]!.text.split('Full evidence: ')[1]!;
    expect(await readFile(path, 'utf8')).toBe(full.trim());
  });
});

test('background input is delivered in order and a nonzero exit is preserved', async () => {
  const p = record('read a; read b; printf "%s:%s" "$a" "$b"; exit 7');
  await launchProcess(p, cliCommand(), 200);
  await controlProcess('test', p.id, 'input', 'first\n');
  await controlProcess('test', p.id, 'input', 'second\n');
  const final = await settled(p.id); expect(final.state).toBe('failed'); expect(final.exitCode).toBe(7);
  expect((await processOutput('test', p.id)).content).toBe('first:second');
});

test('cancelling a starting command prevents its side effect', async () => {
  const { saveProcess } = await import('../data/processes');
  const p = record('touch should-not-exist'); await saveProcess(p);
  await controlProcess('test', p.id, 'stop');
  await launchProcess(p, cliCommand(), 0);
  expect((await settled(p.id)).state).toBe('cancelled');
  expect(await Bun.file(join(cwd, 'should-not-exist')).exists()).toBe(false);
});

test('lost supervisor produces unknown once without replaying the command', async () => {
  const { saveProcess, reconcileProcesses } = await import('../data/processes');
  const p = { ...record('touch never-replay'), supervisorPid: 99999999, state: 'running' as const };
  await saveProcess(p); await reconcileProcesses('test'); await reconcileProcesses('test');
  const final = await readProcess('test', p.id); expect(final.state).toBe('unknown'); expect(final.events).toHaveLength(1);
  expect(await Bun.file(join(cwd, 'never-replay')).exists()).toBe(false);
});

test('output floods are bounded and fail visibly', async () => {
  const p = record('yes verbose'); await launchProcess(p, cliCommand(), 0);
  const final = await settled(p.id); expect(final.state).toBe('failed'); expect(final.reason).toContain('output limit');
  const output = await processOutput('test', p.id); expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(p.maxBytes);
});

test('preview readiness and cancellation are separate durable events', async () => {
  const reserve = Bun.serve({ port: 0, fetch: () => new Response('reserved') }), port = reserve.port;
  await reserve.stop(true);
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const p = { ...record(`${quote(process.execPath)} -e ${quote(`Bun.serve({port:${port},fetch:()=>new Response('preview')})`)}`, 10000), readyUrl: `http://127.0.0.1:${port}/` };
  await launchProcess(p, cliCommand(), 0);
  let ready = false;
  for (let i = 0; i < 160; i++) { if ((await readProcess('test', p.id)).readyAt) { ready = true; break; } await Bun.sleep(25); }
  if (!ready) throw new Error(JSON.stringify({ state: await readProcess("test", p.id), output: await processOutput("test", p.id) }));
  await controlProcess('test', p.id, 'stop'); const final = await settled(p.id);
  expect(final.state).toBe('cancelled'); expect(final.events.map(e => e.event.state)).toEqual(['ready', 'cancelled']);
});

test('workspace execution policy enforces writes while preserving explicit full access', async () => {
  const { saveConfig } = await import('../../config');
  const { shellCommand } = await import('../execution');
  expect(await shellCommand('true', cwd, false)).toEqual(['sh', '-c', 'true']);
  await saveConfig({ sandbox: 'workspace' });
  if (!['darwin', 'linux'].includes(process.platform) || !Bun.which(process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap')) {
    await expect(shellCommand('true', cwd, false)).rejects.toThrow('sandbox'); return;
  }
  const run = async (command: string, readOnly: boolean) => {
    const child = Bun.spawn(await shellCommand(command, cwd, readOnly), { cwd, stdout: 'ignore', stderr: 'ignore' });
    return child.exited;
  };
  expect(await run('printf allowed > allowed; printf denied > ../outside', false)).not.toBe(0);
  expect(await Bun.file(join(cwd, 'allowed')).text()).toBe('allowed');
  expect(await Bun.file(join(home, 'outside')).exists()).toBe(false);
  expect(await run('printf denied > review-write', true)).not.toBe(0);
  expect(await Bun.file(join(cwd, 'review-write')).exists()).toBe(false);
});
