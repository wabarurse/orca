import { gunzipSync } from 'node:zlib';
import { matrix, type Row } from './run';
import { arms, hash, limits } from './design';
export async function readRows():Promise<Row[]> {
 const file=await Bun.file(new URL('results/live.jsonl.gz',import.meta.url)).arrayBuffer();
 return gunzipSync(file).toString().trim().split('\n').map(s=>JSON.parse(s));
}
function assert(ok:unknown,msg:string):asserts ok {if(!ok)throw Error(msg);}
export function aggregate(rows:Row[]) {
 assert(rows[0]?.kind==='run'&&rows[0]?.dry===false,'missing live run');
 assert(rows.filter(r=>r.kind==='run').length===1&&rows.filter(r=>r.kind==='done').length===1&&rows.at(-1)?.kind==='done','incomplete matrix');
 assert(!rows.some(r=>['failure','stopped'].includes(r.kind)),'failed matrix');
 const calls=rows.filter(r=>r.kind==='call'),attempts=rows.filter(r=>r.kind==='attempt'),done=rows.at(-1)!;
 assert(calls.length===attempts.length&&calls.length===done.calls,'call mismatch');
 for(const [i,c]of calls.entries()){
  const a=attempts[i];assert(a,"missing attempt");assert(c.call===i+1&&a?.call===c.call&&a.requestHash===c.requestHash&&hash(a.request)===a.requestHash&&hash(c.request)===c.requestHash,'request mismatch');
  assert(c.arm===a.arm&&c.turn===a.turn&&c.job===a.job,'attempt mismatch');
  const u=c.result?.usage;assert(u&&['input','output'].every(k=>Number.isFinite(u[k])&&u[k]>=0),'missing usage');
  assert(u.cachedInput===undefined||(Number.isFinite(u.cachedInput)&&u.cachedInput>=0),'invalid cache usage');
 }
 const input=calls.reduce((n,c)=>n+c.inputEstimate,0),output=calls.reduce((n,c)=>n+c.request.maxTokens,0);
 assert(done.input===input&&done.output===output&&input<=limits.input&&output<=limits.output&&calls.length<=limits.calls&&done.elapsedMs<=limits.wall,'budget/totals mismatch');
 assert(rows.filter(r=>r.kind==='checkpoint').length===arms.length*10,'checkpoint count');
 const results=arms.map(arm=>{
  const points=rows.filter(r=>r.kind==='checkpoint'&&r.arm===arm),cs=calls.filter(r=>r.arm===arm),jobs=rows.filter(r=>r.kind==='job'&&r.arm===arm);
  assert(points.length===10&&points.every((p,i)=>p.turn===(i+1)*11),'partial arm');
  assert(jobs.length===points.at(-1)!.jobs&&jobs.every((j,i)=>j.job===i+1),'job mismatch');
  assert(jobs.every(j=>Number.isFinite(j.latencyMs)&&j.latencyMs>=0&&j.latencyMs<=limits.job),'job timeout');
  return {arm,calls:cs.length,jobs:jobs.length,estimatedInput:cs.reduce((s,c)=>s+c.inputEstimate,0),measuredInput:cs.reduce((s,c)=>s+c.result.usage.input,0),measuredOutput:cs.reduce((s,c)=>s+c.result.usage.output,0),cachedInput:cs.reduce((s,c)=>s+(c.result.usage.cachedInput??0),0),latencyMs:cs.reduce((s,c)=>s+c.latencyMs,0),exposure:points.at(-1)!.exposure,finalRetained:points.at(-1)!.retained,checkpoints:points.map(p=>({turn:p.turn,retained:p.retained,summary:p.summaryScore,retainedScore:p.retainedScore})),memories:jobs.map(j=>({turn:j.turn,memory:JSON.parse(j.memory)}))};
 });
 return {calls:done.calls,estimatedInput:input,requestedOutput:output,elapsedMs:done.elapsedMs,measuredInput:results.reduce((s,r)=>s+r.measuredInput,0),measuredOutput:results.reduce((s,r)=>s+r.measuredOutput,0),cachedInput:results.reduce((s,r)=>s+r.cachedInput,0),results};
}
export async function replay(rows:Row[]){
 aggregate(rows);const calls=rows.filter(r=>r.kind==='call');let index=0;const actual:Row[]=[];
 await matrix(async(_req,meta)=>{const c=calls[index++];assert(c&&c.requestHash===meta.requestHash&&c.arm===meta.arm&&c.turn===meta.turn&&c.inputEstimate===meta.inputEstimate,'raw replay request mismatch');return c.result;},r=>actual.push(r));
 const stable=(r:Row)=>{const {latencyMs,elapsedMs,...rest}=r;return rest;};
 assert(hash(rows.map(stable))===hash(actual.map(stable)),'raw replay checkpoint/score/totals mismatch');
 return aggregate(rows);
}
if(import.meta.main){const result=await replay(await readRows());await Bun.write(new URL('results/summary.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,results:result.results.map(({checkpoints,memories,...r})=>r)},null,2));}
