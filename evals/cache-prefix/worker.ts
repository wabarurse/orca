/** Current production orchestrator, instrumented at provider/tool boundaries.
 * Credentials are passed in the child environment, consumed into memory, then
 * removed before model-selected tools can execute. No account refresh is used. */
import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodexTokens } from '../../src/login/codex';
import type { Provider } from '../../src/providers';
import type { Tool, ToolResult } from '../../src/core/tools';
const spec=await Bun.file(process.argv[2]!).json();
process.env.ORCA_HOME=spec.state;process.env.PARALLELS_HOME=spec.state;
const load=(path:string)=>import(join(spec.sourceRoot,'src',path));
const {anthropic}=await load('providers/anthropic.ts');
const {openai}=await load('providers/openai.ts');
const {CLAUDE_BETAS}=await load('login/claude.ts');
const {paths,writeProjectState}=await load('config/index.ts');
const {createOrchestrator}=await load('core/agent-loop/orc/index.ts');
const {registry,toolsFor,orchestratorTask}=await load('core/tools/index.ts');
const {editableTool}=await load('core/definitions/index.ts');
const secret=JSON.parse(process.env.ORCA_EVAL_CREDENTIAL!);delete process.env.ORCA_EVAL_CREDENTIAL;
process.env.ORCA_HOME=spec.state;process.env.PARALLELS_HOME=spec.state;
await mkdir(join(spec.state,'.runtime'),{recursive:true,mode:0o700});
await writeFile(paths.config,`model = ${JSON.stringify(spec.model)}\nanthropicPromptCache = true\n`);
const project='trial';
writeProjectState(project,'account',{provider:spec.provider,profile:spec.profile});
writeProjectState(project,'model-settings',{[spec.model]:{effort:'medium',fast:false}});
const base:Provider=spec.provider==='anthropic'?anthropic(new Anthropic({apiKey:null,authToken:null,
 credentials:async()=>({token:secret.accessToken,expiresAt:secret.expiresAt/1000}),
 defaultHeaders:{'anthropic-beta':CLAUDE_BETAS,'x-api-key':null},fetchOptions:{redirect:'error'}}),{promptCache:true,retry:{backoffMs:[]}})
 :openai(async()=>secret as CodexTokens,{retry:{backoffMs:[]}});
const requests:any[]=[],calls:any[]=[];let streamed='';const started=performance.now();
const provider:Provider={...base,account:`${spec.provider}:${spec.profile}`,models:async()=>[spec.model],async complete(req){
 if(requests.length>=30)throw new Error('evaluation request cap reached');
 const index=requests.length,row:any={startMs:performance.now()-started};requests.push(row);
 req={...req,system:[req.system,spec.directSystem].filter(Boolean).join('\n\n')};
 await writeFile(join(spec.dir,`request-${index}.json`),JSON.stringify(req));
 try{const result=await base.complete(req);row.usage=result.usage;row.model=req.model;row.settings=req.settings;
 await writeFile(join(spec.dir,`response-${index}.json`),JSON.stringify(result));return result;
 }catch(e){row.error=String(e);throw e;}finally{row.ms=performance.now()-started-row.startMs;}
}};
const tools:Record<string,Tool<ToolResult>>={};
for(const name of toolsFor.orchestrator){
 const tool=editableTool(name==='task'?orchestratorTask:registry[name]!,name==='task'?'task-orchestrator':name);
 tools[name]={...tool,async run(input,ctx){
 const row:any={name,input,startMs:performance.now()-started};calls.push(row);
 try{
  if(['spawn','task','ask','web_search','runtime'].includes(name))throw new Error('benchmark scope: execute the authorized local assignment directly; no delegation, registration, external access or status queries');
  if(name==='message'&&input.to!=='user')throw new Error('benchmark scope: report only to user');
  const result=await tool.run(input,ctx);row.output=result;
  if(typeof result==='string'&&/\[exit [1-9]\d*\]|\[timed out|^refused:/.test(result))row.commandFailure=true;
  return result;
 }catch(e){row.error=String(e);throw e;}finally{row.ms=performance.now()-started-row.startMs;}
 }};
}
const signal=AbortSignal.timeout(180_000);
const orch=await createOrchestrator({project,provider,tools,signal,write:(s:string,plain?:boolean)=>{if(!plain)streamed+=s;}});
let error:string|undefined,replies:any[]=[];
try{await orch.say(spec.system+'\n\n'+spec.prompt);replies=await orch.turn();}catch(e){error=String(e);}finally{orch.dispose?.();}
const transcript=paths.transcript(project,'orchestrator');
const all=await Bun.file(transcript).text();const entries=all.split('\n').filter(Boolean).map(l=>JSON.parse(l));
const returned=entries.filter(e=>e.type==='message'&&e.message?.role==='user').flatMap(e=>Array.isArray(e.message.content)?e.message.content:[]).filter(b=>b.type==='tool_result');
const hasUsage=requests.length>0&&requests.every(r=>r.usage);
const sum=(key:string)=>hasUsage?requests.reduce((n,r)=>n+(r.usage[key]??0),0):null;
const answer=replies.length?replies.map(r=>r.text).join('\n'):streamed.trim();
await writeFile(join(spec.dir,'calls.json'),JSON.stringify(calls,null,2));
await writeFile(join(spec.dir,'request-metrics.json'),JSON.stringify(requests,null,2));
console.log(JSON.stringify({answer,error,inputTokens:sum('input'),cachedInputTokens:sum('cachedInput'),
 cacheWriteInputTokens:requests.every(r=>r.usage?.cacheWriteInput!==undefined)?sum('cacheWriteInput'):null,outputTokens:sum('output'),reasoningTokens:requests.every(r=>r.usage?.reasoning!==undefined)?sum('reasoning'):null,
 peakInputTokens:hasUsage?Math.max(...requests.map(r=>r.usage.input)):null,requests:requests.length,calls:calls.length,
 tools:calls.map(c=>c.name),failedToolCalls:returned.filter(r=>r.is_error).length,failedCommands:calls.filter(c=>c.commandFailure).length,
 resultBytes:calls.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify(c.output??'')),0),modelMs:requests.reduce((n,r)=>n+r.ms,0),
 actualModels:[...new Set(requests.map(r=>r.model).filter(Boolean))],permissionDenials:[],transcript,productionOrchestrator:true}));
