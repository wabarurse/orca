import { appendFileSync, existsSync } from 'node:fs';
import { provider } from '../../src/accounts';
import { estimate, budget } from '../../src/compaction';
import type { Provider, CompleteRequest, Turn } from '../../src/providers';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { summarizeOlder } from '../../src/rolling-summary';
import { rollingCut } from '../../src/rolling-memory';
import { memoryText } from './memory-text';
import { arms, fixture, hash, limits, policies, registry, score } from './design';
export type Row = Record<string, any>;
export async function matrix(complete:(r:CompleteRequest,meta:Row)=>Promise<Turn>,emit:(r:Row)=>void, dry=false) {
 const started=Date.now(); let calls=0,input=0,output=0;
 const histories=fixture();
 emit({kind:'run',fixtureHash:hash(histories),originalEstimate:estimate(histories.flat()),policies,limits,dry});
 for(const arm of arms){
  let context:MessageParam[]=[], memory='', exposure=0, jobs=0;
  for(let i=0;i<histories.length;i++){
   context.push(...histories[i]!); if((i+1)%11)continue;
   const turn=i+1, before=estimate(context);
   // Production budget includes empty system/tools and fixed 1024 overhead.
   const triggerBudget=budget({model:'gpt-6-luna',system:'',tools:{},transcript:null!,ctx:null!},context);
   exposure+=triggerBudget;
   if(triggerBudget>=arm){
    const cut=rollingCut(context,20000); if(!cut)throw Error('no cut'); jobs++;
    const jobStarted=Date.now();
    const signal=AbortSignal.any([AbortSignal.timeout(limits.job),AbortSignal.timeout(Math.max(1,limits.wall-(Date.now()-started)))]);
    const wrapped:Provider={name:'openai',models:async()=>[],complete:async req=>{
     const inputEstimate=estimate(req.messages)+estimate(req.system);
     if(calls+1>limits.calls||input+inputEstimate>limits.input||output+req.maxTokens>limits.output||Date.now()-started>=limits.wall)throw Error('budget exceeded');
     calls++;input+=inputEstimate;output+=req.maxTokens;
     const {signal:_,onText:__,...request}=req;
     const meta={arm,turn,job:jobs,call:calls,inputEstimate,request,requestHash:hash(request)};
     emit({kind:'attempt',...meta});const start=Date.now();
     try {const result=await complete(req,meta);emit({kind:'call',...meta,result,latencyMs:Date.now()-start});return result;}
     catch(e){emit({kind:'failure',...meta,error:String(e),latencyMs:Date.now()-start});throw e;}
    }};
    const result=await summarizeOlder(context.slice(0,cut),registry(turn),signal,async()=>wrapped);
    memory=JSON.stringify(result);
    context=[{role:'user',content:memoryText(result,registry(turn))},...context.slice(cut)];
    emit({kind:'job',arm,turn,job:jobs,cut,before,after:estimate(context),memory,latencyMs:Date.now()-jobStarted});
   }
   emit({kind:'checkpoint',arm,turn,before,triggerBudget,retained:estimate(context),exposure,jobs,contextHash:hash(context),summaryScore:score(memory,turn),retainedScore:score(JSON.stringify(context),turn)});
  }
 }
 emit({kind:'done',calls,input,output,elapsedMs:Date.now()-started});
}
if(import.meta.main){
 const dry=process.argv.includes('--dry');const path=new URL(`results/${dry?'plan':'live'}.jsonl`,import.meta.url);
 if(existsSync(path)||existsSync(new URL(path.href+'.gz')))throw Error('refuse overwrite');
 const emit=(r:Row)=>appendFileSync(path,JSON.stringify(r)+'\n');
 const p=dry?null:await provider('openai');
 try{await matrix(async req=>dry?{stop:'end',completion:'completed',content:[{type:'text',citations:[],text:JSON.stringify({user:Array(8).fill('x'.repeat(900)),project:[],pending:[],tasks:[]})}],usage:{input:0,output:0}}:p!.complete(req),emit,dry);}
 catch(e){emit({kind:'stopped',error:String(e)});process.exitCode=1;}
}
