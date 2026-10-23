const rows = (await Bun.file(new URL('results/live.jsonl', import.meta.url)).text()).trim().split('\n').map(x => JSON.parse(x));
const results = [...new Set(rows.filter(r => r.arm).map(r => r.arm))].map(arm => {
 const calls = rows.filter(r => r.arm === arm && r.kind === 'call');
 const points = rows.filter(r => r.arm === arm && r.kind === 'checkpoint');
 const last = points.at(-1);
 return { arm, calls: calls.length, compactions: last.compactions, input: calls.reduce((a,r)=>a+r.usage.input,0), output: calls.reduce((a,r)=>a+r.usage.output,0), cachedInput: calls.reduce((a,r)=>a+(r.usage.cachedInput ?? 0),0), latencyMs: calls.reduce((a,r)=>a+r.latencyMs,0), exposure: last.exposure, finalSummary: last.summaryScore, finalRetained: last.retainedScore, matchingCheckpoints: points.filter(r=>[12,24,36].includes(r.turn)).map(r=>({turn:r.turn,retained:r.retained,summary:r.summaryScore,full:r.retainedScore})) };
});
await Bun.write(new URL('results/summary.json', import.meta.url), JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
