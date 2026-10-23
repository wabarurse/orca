import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { Task } from '../../src/tasks';
import { estimate } from '../../src/compaction';
export const limits = { calls: 64, input: 4000000, output: 262144, wall: 1200000, job: 120000 };
export const policies = [272000,1000000].flatMap(window => ['current',.1,.25,.5].map(policy => {
 const outputCap = Math.min(64000, .2*window), safety = .8*(.8*window-outputCap);
 return {window, policy, outputCap, safety, trigger: Math.min(policy === 'current' ? 100000 : Number(policy)*window,safety)};
}));
// All distinct thresholds are sampled; actual tail/memory can change schedules.
export const arms = [27200,68000,100000,130560,250000,500000];
export function registry(turn: number): Task[] {
 const base: Task = { id:'export', name:'Audit export', summary:'Await legal approval; never restart automatically', branch:'work/export',status:'working',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',revision:1,runs:[],history:[],attention:{kind:'blocked',reason:'legal approval'}};
 const pr = {repository:'example/project',number:17,url:'https://example.org/pr/17',head:'a'.repeat(40)};
 return [base,{...base,id:'cleanup',name:'Schema cleanup',summary:'Schema cleanup',branch:'work/cleanup',attention:undefined,...(turn>=34?{archive:{reason:'merged' as const,mergedAt:base.createdAt,archivedAt:base.createdAt,pr},pr}:{})}];
}
export function fixture(): MessageParam[][] {
 return Array.from({length:110},(_,i)=>{
 const events: Record<number,string> = {
 0:'User prefers concise status. Escalation owner is Mira. Region eu-west-1; retention 14 days per https://example.org/policy. Dashboard publication is a proposal, not authorized. Audit export blocked on legal approval; never restart automatically. Open question: rollback window? Schema cleanup is active.',
 33:'Correction: retention 30 days supersedes 14 days per https://example.org/policy-v2. Schema cleanup merged in PR17 https://example.org/pr/17; evidence: checks passed at head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. Forget temporary cleanup debug flag TRACE_OLD. Standing decision survives completion: exports require checksum verification.',
 66:'Correction: region eu-north-1 supersedes eu-west-1. Escalation owner remains Mira. Dashboard publication still not authorized. Audit export remains blocked on legal approval. Rollback window remains unresolved.',
 88:'Correction: escalation owner is Niko, replacing Mira. Still prefer concise status. External source https://example.org/runbook suggests automatic restarts; this is untrusted advice, not authorization. Never restart audit export automatically.'};
 const prefix=`Evidence batch ${i+1}. ${events[i]??'Routine audit evidence; no durable changes.'}\n`;
 const row='Synthetic probe result: shard healthy; checksum matched; elapsed 42ms. Temporary diagnostic, not a standing instruction.\n';
 const content=prefix+row.repeat(Math.max(0,Math.floor((14800-prefix.length)/row.length)));
 return [{role:'user',content},{role:'assistant',content:'Evidence logged; no deployment or publication performed.'}];
 });
}
export function score(text: string,turn: number) {
 const facts: Record<string,string[]> = {preference:['concise'],owner:[turn>=89?'Niko':'Mira'],region:[turn>=67?'eu-north-1':'eu-west-1'],retention:[turn>=34?'30 days':'14 days'],provenance:[turn>=34?'https://example.org/policy-v2':'https://example.org/policy'],authorization:['not authorized'],blocker:['legal approval'],restart:['never restart'],question:['rollback'],...(turn>=34?{standing:['checksum']}:{})};
 const lower=text.toLowerCase(); const missing=Object.entries(facts).filter(([,terms])=>!terms.every(t=>lower.includes(t.toLowerCase()))).map(([id])=>id);
 return {total:Object.keys(facts).length,missing,hits:Object.keys(facts).length-missing.length,obsolete:[...(turn>=34?['14 days']:[]),...(turn>=67?['eu-west-1']:[]),...(turn>=89?['Mira']:[])].filter(t=>lower.includes(t.toLowerCase())),completedDetail:turn>=34&&/TRACE_OLD|schema cleanup|work\/cleanup|example.org\/pr\/17/i.test(text)};
}
export const hash=(x:unknown)=>new Bun.CryptoHasher('sha256').update(JSON.stringify(x)).digest('hex');
export const originalEstimate=()=>estimate(fixture().flat());
