import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../../data/transcripts';
import { appendContext } from './context';
import { restore } from '../../../tui/conversation/restore';
const root=await mkdtemp(join(tmpdir(),'orca-context-prefix-'));
afterAll(()=>rm(root,{recursive:true,force:true}));
const fresh=()=>open(join(root,crypto.randomUUID()+'.jsonl'));
test('unchanged context is persisted once across reopening; changed context appends without rewriting prior messages',async()=>{
 const transcript=fresh();await transcript.append({type:'message',message:{role:'user',content:'human request'}});
 await appendContext(transcript,'first reference');const before=await transcript.chain(),head=transcript.head();
 await appendContext(open(transcript.path),'first reference');expect(open(transcript.path).head()).toBe(head);
 await appendContext(transcript,'second reference');const after=await transcript.chain();
 expect(after.slice(0,before.length)).toEqual(before);expect(after.length).toBe(before.length+1);
 expect(transcript.branch().filter(e=>e.type==='message'&&e.contextSnapshot)).toHaveLength(2);
});
test('context removal appends one superseding update; initially empty context adds nothing',async()=>{
 const transcript=fresh();await appendContext(transcript,'');expect(transcript.head()).toBeNull();
 await appendContext(transcript,'old reference');await appendContext(transcript,'');const head=transcript.head();
 await appendContext(transcript,'');expect(transcript.head()).toBe(head);
 expect(JSON.stringify(await transcript.chain())).toContain('No reference content');
});
test('compaction retains a current snapshot without duplication, or restores it when summarized away',async()=>{
 const transcript=fresh();await appendContext(transcript,'current instructions');const context=(await transcript.chain())[0]!;
 await transcript.append({type:'summary',text:'checkpoint',retained:[context]});const head=transcript.head();
 await appendContext(transcript,'current instructions');expect(transcript.head()).toBe(head);
 await transcript.append({type:'summary',text:'new checkpoint',retained:[]});
 await appendContext(transcript,'current instructions');
 const chain=await transcript.chain();expect(chain).toHaveLength(2);expect(JSON.stringify(chain)).toContain('current instructions');
});
test('clear boundaries forget previous snapshot identity and seed the next context once',async()=>{
 const transcript=fresh();await appendContext(transcript,'current');await transcript.append({type:'context-boundary'});
 await appendContext(transcript,'current');expect(await transcript.chain()).toHaveLength(1);
});
test('engine context is retained for the model but hidden from conversation restoration',async()=>{
 const transcript=fresh();await appendContext(transcript,'[user] secret-looking reference\nshould not become a chat bubble');
 expect(restore(transcript.history!(), 80)).toEqual([]);expect(JSON.stringify(await transcript.chain())).toContain('reference');
});
test('cancellation and a failed ownership guard publish no context',async()=>{
 const transcript=fresh(),controller=new AbortController();controller.abort();
 await expect(appendContext(transcript,'no',controller.signal)).rejects.toThrow();expect(transcript.head()).toBeNull();
 await expect(appendContext(transcript,'no',undefined,{head:null,check:()=>{throw new Error('stale execution');}})).rejects.toThrow('stale execution');
 expect(transcript.head()).toBeNull();
});


test('section updates do not repeat unchanged instructions and skills; removed sections get one clear update',async()=>{
 const transcript=fresh();await appendContext(transcript,{instructions:'repository rules',skills:'skill list',brief:'first'});
 await appendContext(transcript,{instructions:'repository rules',skills:'skill list',brief:'second'});
 const update=(await transcript.chain()).at(-1)!;
 expect(JSON.stringify(update)).toContain('second');expect(JSON.stringify(update)).not.toContain('repository rules');expect(JSON.stringify(update)).not.toContain('skill list');
 await appendContext(transcript,{instructions:'repository rules',brief:'second'});
 expect(JSON.stringify((await transcript.chain()).at(-1))).toContain('No reference content');
 const head=transcript.head();await appendContext(transcript,{instructions:'repository rules',brief:'second'});expect(transcript.head()).toBe(head);
});
