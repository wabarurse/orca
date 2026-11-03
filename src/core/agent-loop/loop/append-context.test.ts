import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../../config';
import { open } from '../../data/transcripts';
import { createAgent } from './agent';
import type { CompleteRequest, Provider } from '../../../providers';
const root=await mkdtemp(join(tmpdir(),'orca-append-agent-'));
const saved={ORCA_HOME:process.env.ORCA_HOME,PARALLELS_HOME:process.env.PARALLELS_HOME};
process.env.ORCA_HOME=root;process.env.PARALLELS_HOME=root;
afterAll(async()=>{await rm(root,{recursive:true,force:true});for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
const base=(project:string)=>({project,role:'worker' as const,cwd:root});
test('real loop keeps system and earlier messages stable while knowledge changes after a tool',async()=>{
 const ctx=base('append');await mkdir(paths.project(ctx.project),{recursive:true});
 const transcript=open(paths.transcript(ctx.project,'worker'));
 await transcript.append({type:'message',message:{role:'user',content:'original assignment'}});
 let knowledge='original reference';const seen:CompleteRequest[]=[];
 const provider:Provider={name:'anthropic',models:async()=>['m'],async complete(req){seen.push(structuredClone({system:req.system,messages:req.messages,tools:req.tools,cacheScope:req.cacheScope}) as CompleteRequest);
  return seen.length===1?{stop:'tool_use',content:[{type:'tool_use',id:'change',name:'change',input:{},caller:{type:'direct'}}]}:{stop:'end',content:[{type:'text',text:'done',citations:[]}]};}};
 await createAgent({ctx,transcript,provider,model:'m',system:'stable role rules',compaction:{enabled:false},loadContext:async()=>knowledge,
  tools:{change:{spec:{name:'change',input_schema:{type:'object',properties:{}}},async run(){knowledge='updated reference';return'updated';}}},write:()=>{}}).run();
 expect(seen).toHaveLength(2);expect(seen.map(r=>r.cacheScope)).toEqual([transcript.path,transcript.path]);expect(seen.map(r=>r.system)).toEqual(['stable role rules','stable role rules']);
 expect(seen[1]!.messages.slice(0,seen[0]!.messages.length)).toEqual(seen[0]!.messages);
 expect(JSON.stringify(seen[1]!.messages.at(-1))).toContain('updated reference');
 expect(seen[1]!.tools).toEqual(seen[0]!.tools);
});
test('manual compaction keeps stable system and restores current reference before the next request',async()=>{
 const ctx=base('compact');await mkdir(paths.project(ctx.project),{recursive:true});const transcript=open(paths.transcript(ctx.project,'worker'));
 await transcript.append({type:'message',message:{role:'user',content:'assignment'}});const systems:string[]=[];
 const provider:Provider={name:'anthropic',models:async()=>['m'],async complete(req){systems.push(req.system!);return{stop:'end',content:[{type:'text',text:'done',citations:[]}]};}};
 const agent=createAgent({ctx,transcript,provider,model:'m',system:'stable',loadContext:async()=>'current reference',tools:{},write:()=>{},
  compactBoundary:async(_deps,manual)=>{if(manual)await transcript.append({type:'summary',text:'summary X',retained:[]});}});
 await agent.run();await agent.compact();
 expect(JSON.stringify(await transcript.chain())).toContain('current reference');
 await transcript.append({type:'message',message:{role:'user',content:'continue'}});await agent.run();
 expect(systems).toEqual(['stable','stable']);
});
