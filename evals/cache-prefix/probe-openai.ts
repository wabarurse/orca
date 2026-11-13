/** Explicit live compatibility probe; no refresh, state writes or tool execution. */
import { readCodexTokens } from '../../src/api/auth/codex';
import { CODEX_BASE_URL } from '../../src/api/openai';
const token=await readCodexTokens(process.env.CACHE_PROFILE??'phoebe');
if(!process.argv.includes('--live')||!token||token.expiresAt<Date.now()+600_000)throw new Error('explicit --live and a valid subscription token are required');
const stable='These are stable reference identifiers. Answer the user with exactly OK.\n'+Array.from({length:350},(_,i)=>`reference_${i}: immutable configuration value ${i}`).join('\n');
const cases=[{name:'explicit-prefix-and-options',options:true,marker:true},{name:'explicit-prefix-only',options:false,marker:true},{name:'stable-cache-key',options:false,marker:false}];
for(const trial of cases){
 const body={model:'gpt-6-astra',instructions:'You are Codex, an AI coding agent.',store:false,stream:true,prompt_cache_key:'orca-prefix-compatibility-v1',reasoning:{effort:'medium'},
  input:[{role:'developer',content:[{type:'input_text',text:stable,...(trial.marker?{prompt_cache_breakpoint:{mode:'explicit'}}:{})}]},{role:'user',content:[{type:'input_text',text:'Reply OK.'}]}],
  ...(trial.options?{prompt_cache_options:{mode:'implicit',ttl:'30m'}}:{})};
 const response=await fetch(CODEX_BASE_URL+'/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(60_000),
  headers:{authorization:`Bearer ${token.accessToken}`,'chatgpt-account-id':token.accountId,originator:'codex_cli_rs','openai-beta':'responses=experimental','content-type':'application/json'},body:JSON.stringify(body)});
 const text=await response.text();
 if(!response.ok){console.log(JSON.stringify({trial:trial.name,status:response.status,error:text.replaceAll(token.accessToken,'[redacted]').slice(0,600)}));continue;}
 const events=text.split('\n').filter(l=>l.startsWith('data: ')).flatMap(l=>{try{return[JSON.parse(l.slice(6))]}catch{return[]}});
 const done=events.findLast(e=>['response.completed','response.done'].includes(e.type));
 console.log(JSON.stringify({trial:trial.name,status:response.status,completed:!!done,usage:done?.response?.usage,errors:events.filter(e=>['error','response.failed'].includes(e.type)).map(e=>e.error?.code??e.type)}));
 if(done)break;
}
