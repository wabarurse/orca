import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonLines } from '../efficiency/metrics';
const root=process.argv[2];if(!root)throw new Error('usage: bun evals/comparison/summarize.ts <run-root>');
const rows=jsonLines(await readFile(join(root,'audited.jsonl'),'utf8'));
const rates={opus:{input:4,cacheRead:0.2,cacheWrite5m:5,cacheWrite1h:8,output:20},astra:{input:10,cacheRead:1,cacheWrite:12.5,output:50}};
for(const row of rows){
 if(row.inputTokens===null||row.outputTokens===null||row.cachedInputTokens===null){row.costRangeUSD=null;continue;}
 const input=row.inputTokens,cached=row.cachedInputTokens,output=row.outputTokens;
 if(row.model==='claude-opus-5-5'){
  const writes=row.cacheWriteInputTokens;
  if(writes===null){row.costRangeUSD=null;continue;}
  let writes1h=0,writes5m=writes;
  if(row.engine==='claude'){
   const events=jsonLines(await readFile(join(row.artifacts,'stdout.jsonl'),'utf8'));
   const result=events.findLast(e=>e.type==='result'),details=result?.usage?.cache_creation;
   if(!details){row.costRangeUSD=null;continue;}
   writes1h=details.ephemeral_1h_input_tokens??0;writes5m=details.ephemeral_5m_input_tokens??0;
   if(writes1h+writes5m!==writes)throw new Error('cache TTL token mismatch');
  }
  const usd=((input-cached-writes)*rates.opus.input+cached*rates.opus.cacheRead+writes5m*rates.opus.cacheWrite5m+writes1h*rates.opus.cacheWrite1h+output*rates.opus.output)/1e6;
  row.costRangeUSD=[usd,usd];row.cacheWrite5mTokens=writes5m;row.cacheWrite1hTokens=writes1h;
  row.cliListPriceDifferenceUSD=typeof row.listPriceEstimateUSD==='number'?usd-row.listPriceEstimateUSD:null;
 }else{
  const uncached=input-cached,known=row.cacheWriteInputTokens;
  const lower=(uncached*rates.astra.input+cached*rates.astra.cacheRead+output*rates.astra.output)/1e6;
  row.costRangeUSD=known===null?[lower,lower+uncached*(rates.astra.cacheWrite-rates.astra.input)/1e6]:[lower+known*(rates.astra.cacheWrite-rates.astra.input)/1e6,lower+known*(rates.astra.cacheWrite-rates.astra.input)/1e6];
 }
}
const median=(v:number[])=>{const s=v.toSorted((a,b)=>a-b);return s.length?s.length%2?s[Math.floor(s.length/2)]:((s[s.length/2-1]!+s[s.length/2]!)/2):null;};
function summarize(s:any[]){
 const measured=s.filter(r=>typeof r.inputTokens==='number'&&typeof r.cachedInputTokens==='number'&&typeof r.outputTokens==='number');
 const mean=(key:string)=>{const m=s.filter(r=>typeof r[key]==='number');return m.length?m.reduce((n,r)=>n+r[key],0)/m.length:null;};
 const input=measured.reduce((n,r)=>n+r.inputTokens,0),cached=measured.reduce((n,r)=>n+r.cachedInputTokens,0);
 const prices=s.map(r=>r.costRangeUSD).filter(Boolean);
 return {trials:s.length,passed:s.filter(r=>r.success).length,meanSeconds:s.reduce((n,r)=>n+r.elapsedMs,0)/s.length/1000,medianSeconds:median(s.map(r=>r.elapsedMs))!/1000,
  meanInput:mean('inputTokens'),meanUncachedInput:measured.length?(input-cached)/measured.length:null,cacheReuse:input?cached/input:null,
  meanOutput:mean('outputTokens'),meanPeakInput:mean('peakInputTokens'),peakCoverage:s.filter(r=>typeof r.peakInputTokens==='number').length,
  usageCoverage:measured.length,meanCalls:mean('calls'),toolErrors:s.reduce((n,r)=>n+r.audit.failedToolCalls,0),nonzeroCommands:s.reduce((n,r)=>n+r.audit.nonzeroCommands,0),
  failedCalls:s.reduce((n,r)=>n+r.audit.failedCalls,0),allCalls:s.reduce((n,r)=>n+r.calls,0),
  meanCostRangeUSD:prices.length?[0,1].map(i=>prices.reduce((n,r)=>n+r[i],0)/prices.length):null,costCoverage:prices.length,
  meanRequests:mean('requests'),requestsCoverage:s.filter(r=>typeof r.requests==='number').length,
  meanModelMs:mean('modelMs'),modelMsCoverage:s.filter(r=>typeof r.modelMs==='number').length,
  permissionDenials:s.reduce((n,r)=>n+(r.permissionDenials?.length??0),0)};
}
const arms=[...new Set(rows.map(r=>r.arm))];
const group=(filter:(r:any)=>boolean)=>Object.fromEntries(arms.map(arm=>[arm,summarize(rows.filter(r=>r.arm===arm&&filter(r)))]));
const summary={date:'2026-11-03',kind:'Orca stable-prefix baseline/candidate comparison',rates,
 pricingSources:['https://developers.openai.com/api/docs/models/gpt-6-astra','https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5#pricing'],
 actualSubscriptionChargesUSD:null,coding:group(r=>r.task!=='parallel'),parallel:group(r=>r.task==='parallel'),all:group(()=>true),
 byTask:Object.fromEntries([...new Set(rows.map(r=>r.task))].map(task=>[task,group(r=>r.task===task)])),
 failures:rows.filter(r=>!r.success).map(({arm,task,repeat,error,audit,exitCode})=>({arm,task,repeat,error,audit,exitCode})),
 trials:rows.map(({answer,artifacts,cwd,transcript,audit,...row})=>({...row,audit:{...audit,commands:undefined}}))};
await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({coding:summary.coding,parallel:summary.parallel,failures:summary.failures},null,2));
