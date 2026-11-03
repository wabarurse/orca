/** Independent saved-evidence audit. No inference or live project access. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, grade } from '../efficiency/fixtures';
import { jsonLines, claudeMetrics, codexMetrics } from '../efficiency/metrics';
const root=process.argv[2];if(!root)throw new Error('usage: bun evals/comparison/audit.ts <run-root>');
const rows=jsonLines(await readFile(join(root,'results.jsonl'),'utf8'));
const temporary=await mkdtemp(join(tmpdir(),'orca-comparison-audit-'));
try{
 for(const [i,row]of rows.entries()){
  const reference=join(temporary,String(i));await mkdir(reference);
  const data=await fixture(reference,row.task,row.repeat+73);
  const spec=JSON.parse(await readFile(join(row.artifacts,'spec.json'),'utf8'));
  const events=jsonLines(await readFile(join(row.artifacts,'stdout.jsonl'),'utf8'));
  const engine=spec.engine;
  const metric:any=engine==='claude'?claudeMetrics(events):engine==='codex'?codexMetrics(events):events.at(-1);
  for(const key of ['inputTokens','cachedInputTokens','outputTokens','cacheWriteInputTokens','reasoningTokens','peakInputTokens','calls']){
   if(metric?.[key]!==row[key])throw new Error(`metric mismatch ${key} in trial ${i}`);
  }
  const evidence=engine==='orca'?jsonLines(await readFile(row.transcript,'utf8')):events;
  const commands=new Map<string,string>(),errors=new Set<string>(),nonzero=new Set<string>();
  for(const e of evidence){
   if(e.type==='item.completed'){
    const item=e.item;
    if(item.type==='command_execution'){
     commands.set(item.id,item.command);
     if(typeof item.exit_code==='number'&&item.exit_code!==0)nonzero.add(item.id);
    }else if(item.type==='file_change'&&item.status==='failed')errors.add(item.id);
   }
   for(const block of Array.isArray(e.message?.content)?e.message.content:[]){
    if(block.type==='tool_use'&&block.name.toLowerCase()==='bash')commands.set(block.id,block.input.command);
    if(block.type==='tool_result'){
     if(block.is_error)errors.add(block.tool_use_id);
     const text=typeof block.content==='string'?block.content:JSON.stringify(block.content);
     if(/\[exit [1-9]\d*\]|Exit code:\s*[1-9]\d*|exit code [1-9]\d*/i.test(text))nonzero.add(block.tool_use_id);
    }
   }
  }
  const shell=[...commands.values()];
  const requiredAction=row.task==='repair'?shell.some(c=>/\bbun\s+test\b/.test(c))
   :row.task==='output'?shell.some(c=>/\bbun\s+(?:\.\/)?diagnostic\.ts\b/.test(c))
   :row.task==='parallel'?['alpha','beta','gamma','delta'].every(name=>shell.some(c=>{
    const probes=c.match(/\bbun\s+(?:\.\/)?(?:alpha|beta|gamma|delta)\.ts\b/g)??[];
    return probes.length===1&&new RegExp(`\\bbun\\s+(?:\\./)?${name}\\.ts\\b`).test(c);
   })):true;
  const originals=new Set<string>(),unexpectedChanges:string[]=[];
  for await(const file of new Bun.Glob('**/*').scan({cwd:reference,dot:true,onlyFiles:true})){
   originals.add(file);if(row.task==='repair'&&file==='src/window.ts')continue;
   try{if(!Buffer.from(await Bun.file(join(reference,file)).bytes()).equals(Buffer.from(await Bun.file(join(row.cwd,file)).bytes())))unexpectedChanges.push(file);}
   catch{unexpectedChanges.push(file);}
  }
  for await(const file of new Bun.Glob('**/*').scan({cwd:row.cwd,dot:true,onlyFiles:true}))if(!originals.has(file))unexpectedChanges.push(file);
  if(engine==='orca'){
   const responses=await Promise.all(Array.from({length:row.requests},async(_,n)=>{
    const file=Bun.file(join(row.artifacts,`response-${n}.json`));return await file.exists()?(await file.json()).usage:undefined;
   }));
   for(const [field,key]of [['inputTokens','input'],['cachedInputTokens','cachedInput'],['outputTokens','output']]){
    const value=responses.every(Boolean)?responses.reduce((n,u)=>n+(u[key!]??0),0):null;
    if(value!==row[field!])throw new Error(`provider usage mismatch ${field} trial ${i}`);
   }
  }
  const correct=await grade(row.cwd,row.task,row.answer,data);
  row.engine=engine;row.observedSuccess=row.success;
  row.audit={correct,requiredAction,unexpectedChanges,commands:shell,failedToolCalls:errors.size,nonzeroCommands:nonzero.size,failedCalls:new Set([...errors,...nonzero]).size,
   diagnosticRuns:shell.filter(c=>/\bbun\s+(?:\.\/)?diagnostic\.ts\b/.test(c)).length};
  row.success=row.exitCode===0&&!row.error&&correct&&requiredAction&&unexpectedChanges.length===0;
 }
 await writeFile(join(root,'audited.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 console.log(JSON.stringify({trials:rows.length,passed:rows.filter(r=>r.success).length,failures:rows.filter(r=>!r.success).map(r=>({arm:r.arm,task:r.task,repeat:r.repeat,error:r.error,audit:r.audit}))},null,2));
}finally{await rm(temporary,{recursive:true,force:true});}
