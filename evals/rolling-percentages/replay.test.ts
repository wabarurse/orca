import { expect, test } from 'bun:test';
import { aggregate, readRows, replay } from './replay';
import { fixture, originalEstimate, policies, score } from './design';
import { rollingCut } from '../../src/rolling-memory';
import { estimate } from '../../src/compaction';
import { parseMemory } from '../../src/rolling-summary';
const rows=await readRows();
test('durable raw offline replay verifies every request, parser, cut, checkpoint, rubric and total',async()=>{
 const result=await replay(rows);
 expect(result).toEqual(await Bun.file(new URL('results/summary.json',import.meta.url)).json());
 expect(result.calls).toBe(58);
});
test('matrix aggregation fails closed on partial matrix and missing usage',()=>{
 for(const mutate of [
  (r:any[])=>r.pop(),
  (r:any[])=>r.splice(r.findIndex(x=>x.kind==='checkpoint'),1),
  (r:any[])=>delete r.find(x=>x.kind==='call').result.usage,
  (r:any[])=>r.find(x=>x.kind==='call').result.usage.input=NaN,
  (r:any[])=>r.find(x=>x.kind==='done').input++,
  (r:any[])=>r.find(x=>x.kind==='attempt').request.model='other',
 ]){const copy=structuredClone(rows);mutate(copy);expect(()=>aggregate(copy)).toThrow();}
});
test('replay detects raw response and score corruption',async()=>{
 const copy=structuredClone(rows);copy.find(r=>r.kind==='checkpoint')!.retained++;
 await expect(replay(copy)).rejects.toThrow();
});
test('total-window percentages retain output and safety clamp',()=>{
 expect(policies.map(p=>p.trigger)).toEqual([100000,27200,68000,130560,100000,100000,250000,500000]);
 expect(policies.map(p=>p.outputCap)).toEqual([54400,54400,54400,54400,64000,64000,64000,64000]);
});
test('long identical history crosses 500k; tail is a target, not exact 20k',()=>{
 expect(originalEstimate()).toBe(548080);
 const messages=fixture().flat(),cut=rollingCut(messages,20000);
 expect(estimate(messages.slice(cut))).toBeLessThan(20000);
 expect(messages.slice(cut-1).reduce((n,m)=>n+estimate([m]),0)).toBeGreaterThan(20000);
});
test('rubric includes owner initially, amendments, provenance and completed evidence',()=>{
 const history=fixture();
 expect(score(JSON.stringify(history[0]),1).missing).toEqual([]);
 expect(score(JSON.stringify(history[0]).replaceAll('Mira','unknown'),1).missing).toContain('owner');
 const early=score(JSON.stringify(history[0]),110);
 expect(early.missing).toContain('owner');
 // Deliberate lexical limitation: diagnostic checksum mentions can mask missing standing decision.
 expect(early.missing).not.toContain('standing');
 expect(score('Niko eu-north-1 30 days',110).missing).toContain('standing');
 expect(early.obsolete).toEqual(['14 days','eu-west-1','Mira']);
 expect(score(JSON.stringify(history[33]),44).completedDetail).toBe(true);
 expect(()=>parseMemory('{"user":[],"project":[],"pending":[],"tasks":[{"id":"unknown","notes":"x"}]}',[])).toThrow();
});

test('private memory wrapper remains an exact production-source copy',async()=>{
 const production=await Bun.file(new URL('../../src/rolling-memory.ts',import.meta.url)).text();
 const local=await Bun.file(new URL('memory-text.ts',import.meta.url)).text();
 const body=(source:string)=>source.slice(source.indexOf('function memoryText(')).split('\n}')[0]+'\n}';
 expect(body(local)).toBe(body(production));
});
