/** Matched baseline/candidate evaluation using the previously audited fixture suite.
 * Only access-token snapshots are passed to isolated workers. No real auth refresh. */
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readClaudeTokens } from '../../src/api/auth/claude';
import { readCodexTokens } from '../../src/api/auth/codex';
import { fixture, grade, type Task } from '../efficiency/fixtures';
import { jsonLines } from '../efficiency/metrics';
if(!process.argv.includes('--live'))throw new Error('Explicit --live is required');
const profile=process.env.CACHE_PROFILE??'phoebe';
const anthropic=await readClaudeTokens(profile),openai=await readCodexTokens(profile);
const requested=process.env.CACHE_ARMS?.split(',');
if(((!requested||requested.some(a=>a.endsWith('opus')))&&(!anthropic||anthropic.expiresAt<Date.now()+30*60_000))||((!requested||requested.some(a=>a.endsWith('astra')))&&(!openai||openai.expiresAt<Date.now()+30*60_000)))throw new Error('Selected profiles need valid access tokens; no refresh or fallback');
const baseline=resolve(process.env.CACHE_BASELINE??'/Users/wabarurse/Documents/github/orca-harness-benchmark');
const candidate=resolve(import.meta.dir,'../..');
const root=await mkdtemp(join(tmpdir(),'orca-prefix-ab-'));await chmod(root,0o700);
const system='This is explicitly authorized local work: execute directly in this working directory. Do not delegate, spawn agents, register tasks, ask questions, create scheduled tasks, access the network, install dependencies, inspect credentials/environment/host files, or make commits. Read only workspace files and tool-output artifacts explicitly returned by your tools. Use Bun for JavaScript/TypeScript. Inspect evidence and verify changes. Use concise results. Issue independent read-only tool calls together when possible; keep dependent work ordered. Return the requested final answer; if your harness delivers answers through a message tool, address it to the user.';
const directSystem='Benchmark-specific workflow: execute this small authorized local task directly. This overrides the usual task-registration, delegation, branch, commit, reviewer and approval workflow. The generated fixture intentionally has no Git repository; no branch setup is needed. Inspect files, make requested local changes, run tests and return the requested answer.';
const arms=[{name:'before-opus',provider:'anthropic',model:'claude-opus-5-5',sourceRoot:baseline},
 {name:'after-opus',provider:'anthropic',model:'claude-opus-5-5',sourceRoot:candidate},
 {name:'before-astra',provider:'openai',model:'gpt-6-astra',sourceRoot:baseline},
 {name:'after-astra',provider:'openai',model:'gpt-6-astra',sourceRoot:candidate}];
const selected=arms.filter(a=>!process.env.CACHE_ARMS||process.env.CACHE_ARMS.split(',').includes(a.name));
const tasks=(process.env.CACHE_TASKS?.split(',')??['lookup','repair','repository','output','parallel']) as Task[];
const repeats=Number(process.env.CACHE_REPEATS??3);
if(!selected.length||!Number.isSafeInteger(repeats)||repeats<1||repeats>3||tasks.some(t=>!['lookup','repair','repository','output','parallel'].includes(t)))throw new Error('invalid matrix');
const files=['src/core/agent-loop/loop/agent.ts','src/core/agent-loop/loop/context.ts','src/protocol/transcript.ts','src/providers/anthropic.ts','src/providers/openai.ts','src/providers/provider.ts','src/core/data/knowledge/instructions.ts','src/core/data/knowledge/index.ts','src/core/agent-loop/orc/orchestrator.ts','src/exec/run.ts','src/tui/conversation/restore.ts','evals/cache-prefix/run.ts','evals/cache-prefix/worker.ts'];
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(join(candidate,file))).digest('hex')])));
await writeFile(join(root,'environment.json'),JSON.stringify({date:new Date().toISOString(),baseline,candidate,baselineCommit:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:baseline}).stdout.toString().trim(),sourceHashes,arms:selected,tasks,repeats,profile,system,directSystem,effort:'medium',fast:false},null,2));
console.log(JSON.stringify({root,tasks,repeats,arms:selected.map(a=>a.name)}));
async function manifest(cwd:string){const out:Record<string,string>={};for await(const f of new Bun.Glob('**/*').scan({cwd,dot:true,onlyFiles:true}))out[f]=createHash('sha256').update(await Bun.file(join(cwd,f)).bytes()).digest('hex');return out;}
let stopped=false;
for(let repeat=0;repeat<repeats&&!stopped;repeat++)for(const [index,task]of tasks.entries()){
 const offset=(repeat+index)%selected.length,rotated=[...selected.slice(offset),...selected.slice(0,offset)],order=repeat%2?rotated.reverse():rotated;
 for(const arm of order){
  const dir=await mkdtemp(join(root,'trial-')),state=join(dir,'state'),cwd=join(state,'projects/trial/repo');await mkdir(cwd,{recursive:true});
  const data=await fixture(cwd,task,repeat+73),before=await manifest(cwd);
  const spec={...arm,engine:'orca',profile,dir,state,cwd,prompt:data.prompt,system,directSystem};await writeFile(join(dir,'spec.json'),JSON.stringify(spec,null,2));
  const env:Record<string,string|undefined>={...process.env,HOME:join(dir,'home'),ORCA_HOME:state,PARALLELS_HOME:state,NO_COLOR:'1',TERM:'dumb',CI:'1'};
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CODEX_ACCESS_TOKEN','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_BASE_URL'])delete env[key];
  const token=arm.provider==='anthropic'?anthropic!:openai!;
  env.ORCA_EVAL_CREDENTIAL=JSON.stringify({accessToken:token.accessToken,expiresAt:token.expiresAt,refreshToken:'',...('accountId'in token?{accountId:token.accountId}:{})});
  await mkdir(env.HOME!,{mode:0o700});console.log(`START ${repeat+1}/${repeats} ${task} ${arm.name}`);
  const start=performance.now(),child=Bun.spawn([process.execPath,join(import.meta.dir,'worker.ts'),join(dir,'spec.json')],{cwd,env,stdin:'ignore',stdout:Bun.file(join(dir,'stdout.jsonl')),stderr:Bun.file(join(dir,'stderr.txt')),timeout:210000});
  const exitCode=await child.exited,elapsedMs=performance.now()-start,events=jsonLines(await readFile(join(dir,'stdout.jsonl'),'utf8')),metrics=events.at(-1)??{error:'no worker result'};
  const after=await manifest(cwd),changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(f=>before[f]!==after[f]);
  const scopeOkay=task==='repair'?changed.every(f=>f==='src/window.ts'):changed.length===0,correct=await grade(cwd,task,metrics.answer??'',data);
  const row={arm:arm.name,engine:'orca',model:arm.model,task,repeat,exitCode,elapsedMs,...metrics,success:exitCode===0&&!metrics.error&&scopeOkay&&correct,scopeOkay,changed,grade:correct,artifacts:dir,cwd};
  await appendFile(join(root,'results.jsonl'),JSON.stringify(row)+'\n');console.log(JSON.stringify({arm:arm.name,task,repeat,success:row.success,elapsedMs:Math.round(elapsedMs),inputTokens:row.inputTokens,cachedInputTokens:row.cachedInputTokens,error:row.error}));
  if((row.error||exitCode!==0)&&(!row.calls||/quota|usage.limit|rate.limit|unauthoriz|not.signed/i.test(row.error??''))){stopped=true;break;}
 }
 if(stopped)break;
}
console.log(JSON.stringify({complete:!stopped,root}));
