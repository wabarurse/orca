/** Inspect saved request boundaries and distinguish fresh-prefix reuse from
 * follow-up cache hits. No model requests or workspace mutation. */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonLines } from '../efficiency/metrics';
const root=process.argv[2];if(!root)throw new Error('usage: bun evals/cache-prefix/cache-metrics.ts <run-root>');
const rows=jsonLines(await readFile(join(root,'audited.jsonl'),'utf8'));
const metrics:Record<string,any>={};
for(const row of rows){
 const target=metrics[row.arm]??={trials:0,firstInput:0,firstCached:0,followupInput:0,followupCached:0,appendOnlyTrials:0,systemStableTrials:0,systems:new Set<string>()};
 const requests=JSON.parse(await readFile(join(row.artifacts,'request-metrics.json'),'utf8'));
 const bodies=await Promise.all(requests.map((_:unknown,i:number)=>Bun.file(join(row.artifacts,`request-${i}.json`)).json()));
 target.trials++;
 for(let i=0;i<requests.length;i++){
  if(!requests[i].usage)continue;
  target[i===0?'firstInput':'followupInput']+=requests[i].usage.input;
  target[i===0?'firstCached':'followupCached']+=requests[i].usage.cachedInput??0;
 }
 const stable=bodies.every(b=>b.system===bodies[0].system&&JSON.stringify(b.tools)===JSON.stringify(bodies[0].tools));
 if(stable)target.systemStableTrials++;
 if(stable&&bodies.every((b,i)=>i===0||JSON.stringify(b.messages.slice(0,bodies[i-1].messages.length))===JSON.stringify(bodies[i-1].messages)))target.appendOnlyTrials++;
 for(const b of bodies)target.systems.add(b.system);
}
for(const value of Object.values(metrics)){
 value.firstRequestCacheHit=value.firstInput?value.firstCached/value.firstInput:null;
 value.followupCacheHit=value.followupInput?value.followupCached/value.followupInput:null;
 value.distinctSystemPrefixes=value.systems.size;delete value.systems;
}
await writeFile(join(root,'cache-metrics.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics,null,2));
