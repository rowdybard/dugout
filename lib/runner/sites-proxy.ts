import {MAX_REQUEST_BYTES,RunnerError,signRunnerRequest} from './protocol.ts';
import type {RunnerState} from './contracts';
import type {TennisAction,TennisSession} from '../tennis/types';
import {polymarketSecrets} from '../trading/credentials.ts';
import {PAPER_FILLS} from '../tennis/maker.ts';

export type RunnerBindings={DUGOUT_OWNER_ID?:string;DUGOUT_RUNNER_USERS?:string;DUGOUT_RUNNER_URL?:string;DUGOUT_RUNNER_SECRET?:string;POLYMARKET_KEY_ID?:string;POLYNARKET_KEY_ID?:string;POLYMARKET_SECRET_KEY?:string};
export type OwnerFence={owner_id:string;mode:'frozen'|'active';epoch:string;migration_id:string;snapshot:string;revision:number};
export type RunnerDatabase=Pick<D1Database,'prepare'|'batch'>;

/** Sites' private outer boundary supplies this header. Never infer an owner. */
export function requireSitesOwner(request:Request):string{
  const owner=request.headers.get('oai-authenticated-user-id');
  if(!owner||!/^[a-zA-Z0-9_-]{8,160}$/.test(owner))throw new RunnerError(401,'Sign in to your private Dugout account.');
  return owner;
}
export function requireRunnerOrigin(request:Request):void{
  if(request.headers.get('origin')!==new URL(request.url).origin||['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')??''))throw new RunnerError(403,'Request origin mismatch.');
}
export function runnerConfiguration(env:RunnerBindings):{url:string;secret:string}{
  let url:URL;try{url=new URL(env.DUGOUT_RUNNER_URL??'');}catch{throw new RunnerError(503,'Background runner is not configured.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)||!env.DUGOUT_RUNNER_SECRET||env.DUGOUT_RUNNER_SECRET.length<32)throw new RunnerError(503,'Background runner is not configured.');
  return {url:url.origin,secret:env.DUGOUT_RUNNER_SECRET};
}
export async function readOwnerFence(database:RunnerDatabase,owner:string):Promise<OwnerFence|null>{
  // A database error is not browser mode; callers must never catch it and run locally.
  return database.prepare('SELECT owner_id,mode,epoch,migration_id,snapshot,revision FROM tennis_runner_owners WHERE owner_id=?').bind(owner).first<OwnerFence>();
}
/** Use before legacy readTennisSession/profile so catalog, stream and adviser
 * context also resolve to the authoritative runner account after activation. */
export async function readRunnerOwnedSession(request:Request,database:RunnerDatabase,env:RunnerBindings):Promise<{ownerId:string;session:TennisSession;stored:true}|null>{
  const owner=requireSitesOwner(request),fence=await readOwnerFence(database,owner);
  if(!fence)return null;
  const session=fence.mode==='frozen'?JSON.parse(fence.snapshot) as TennisSession:(await runnerRequest<RunnerState>(env,owner,fence.epoch,'/v1/state')).session;
  return {ownerId:owner,session,stored:true};
}
async function boundedText(response:Response):Promise<string>{
  if(!response.body)throw new RunnerError(502,'Background runner returned no response.');
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>4_000_000)throw new RunnerError(502,'Background runner response is too large.');text+=decoder.decode(item.value,{stream:true});}text+=decoder.decode();}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  return text;
}
async function boundedJson(response:Response):Promise<unknown>{
  const text=await boundedText(response);
  let parsed:unknown;try{parsed=JSON.parse(text);}catch{throw new RunnerError(502,'Background runner returned an unreadable response.');}
  if(!response.ok){const message=parsed&&typeof parsed==='object'&&'error'in parsed&&typeof parsed.error==='string'?parsed.error:'Background runner request failed.';throw new RunnerError(response.status>=400&&response.status<600?response.status:502,message);}
  return parsed;
}
async function runnerFetch(env:RunnerBindings,owner:string,epoch:string,path:string,method:'GET'|'POST'='GET',value?:unknown,fetcher:typeof fetch=fetch):Promise<Response>{
  const config=runnerConfiguration(env);
  if(!/^\/v1\/(?:state|command|export|feed-credentials|migration\/(?:start|chunk|status|activate))(?:\?[^#]*)?$/.test(path))throw new RunnerError(400,'Unsupported runner route.');
  const url=config.url+path,body=value===undefined?'':JSON.stringify(value);
  if(new TextEncoder().encode(body).byteLength>MAX_REQUEST_BYTES)throw new RunnerError(413,'Background runner request is too large.');
  const headers=await signRunnerRequest(config.secret,url,method,body,owner,epoch);
  let response:Response;
  try{response=await fetcher(url,{method,headers:{...headers,'Content-Type':'application/json'},body:method==='GET'?undefined:body,signal:AbortSignal.timeout(15000),redirect:'manual'});}
  catch(error){
    // Log only transport diagnostics, never signed headers, request data or credentials.
    const diagnostic=(error instanceof Error?`${error.name}: ${error.message}`:'Unknown fetch failure').replaceAll(config.secret,'[redacted]').slice(0,300);
    console.error('Dugout runner transport:',diagnostic);
    throw new RunnerError(503,'Background runner is unreachable. Browser trading remains disabled for this account.');
  }
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw new RunnerError(502,'The background runner returned a redirect. Its signed request was not forwarded.');}
  return response;
}
export async function runnerRequest<T>(env:RunnerBindings,owner:string,epoch:string,path:string,method:'GET'|'POST'='GET',value?:unknown,fetcher:typeof fetch=fetch):Promise<T>{
  return await boundedJson(await runnerFetch(env,owner,epoch,path,method,value,fetcher)) as T;
}
/**
 * The runner's state, passed through as text. The session is large (hundreds of notes, the balance history), and
 * parsing then re-serializing it on every 2.5-second poll could exceed the Workers free plan's 10 ms CPU limit per
 * request (a plain 503). The runner sends its small status block in the `x-dugout-runner` header; the body is kept
 * as received. Older runners without the header fall back to parsing.
 */
export async function runnerStateText(env:RunnerBindings,owner:string,epoch:string,path:string,method:'GET'|'POST'='GET',value?:unknown,fetcher:typeof fetch=fetch):Promise<{text:string;runner:RunnerState['runner']}>{
  const response=await runnerFetch(env,owner,epoch,path,method,value,fetcher);
  const header=response.ok?response.headers.get('x-dugout-runner'):null;
  if(!header){const state=await boundedJson(response) as RunnerState;return {text:JSON.stringify(state),runner:state.runner};}
  let runner:RunnerState['runner'];try{runner=JSON.parse(decodeURIComponent(header));}catch{throw new RunnerError(502,'Background runner returned an unreadable status.');}
  const text=(await boundedText(response)).trim();
  if(!text.startsWith('{')||!text.endsWith('}'))throw new RunnerError(502,'Background runner returned an unreadable response.');
  return {text,runner};
}
function sessionResponse({text,runner}:{text:string;runner:RunnerState['runner']},env:RunnerBindings){
  // The sweep summary stays in the body (top-level `sweep`); the dashboard reads it from there.
  const runtime={mode:'service',intervalMs:2500,backgroundConnected:true,streamConfigured:!!polymarketSecrets(env as Record<string,unknown>),description:'The private paper runner continues when this page is closed.',lastSuccessfulCheck:runner.lastEngineCheck,quoteAgeMs:runner.quoteAgeMs,gameReportAgeMs:runner.contextAgeMs,failureReason:runner.source.state==='error'?runner.source.message:null,usage:runner.usage,feedKey:runner.feedKey===true};
  return new Response(`${text.slice(0,-1)},"runtime":${JSON.stringify(runtime)}}`,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
/** `session` is on the first page only. */
type ExportPage={schemaVersion:3;exportId:string;capturedAt:number;session?:TennisSession;records:unknown[];observations:{id:string;value:unknown}[];nextCursor:number;complete:boolean;pageEvidenceComplete:boolean;missingObservationIds:string[];exactReplayStartsAt:'migration-checkpoint'};
async function runnerExport(env:RunnerBindings,fence:OwnerFence):Promise<Response>{
  const first=await runnerRequest<ExportPage>(env,fence.owner_id,fence.epoch,'/v1/export?after=0&limit=250');
  const next=async(after:number)=>{
    const result=await runnerRequest<ExportPage>(env,fence.owner_id,fence.epoch,`/v1/export?exportId=${encodeURIComponent(first.exportId)}&after=${after}&limit=250`);
    if(result.exportId!==first.exportId||result.nextCursor<after||!result.complete&&result.nextCursor===after)throw new RunnerError(502,'Background journal export did not advance.');
    return result;
  };
  async function* chunks(){
    yield `{"schemaVersion":3,"capturedAt":${first.capturedAt},"paperFills":${JSON.stringify(PAPER_FILLS)},"exactReplayStartsAt":${JSON.stringify(first.exactReplayStartsAt??null)},"session":${JSON.stringify(first.session)},"records":[`;
    let page=first,count=0,observations=0;
    let evidenceComplete=true;const missing=new Set<string>();
    const inspectEvidence=(value:ExportPage)=>{
      // Pagination completion says nothing about missing source evidence. Preserve
      // the runner's separate evidence result across every page and both passes.
      evidenceComplete=evidenceComplete&&value.pageEvidenceComplete===true;
      if(!Array.isArray(value.missingObservationIds))evidenceComplete=false;
      else for(const id of value.missingObservationIds)if(typeof id==='string')missing.add(id);else evidenceComplete=false;
      if(value.exactReplayStartsAt!==first.exactReplayStartsAt)throw new RunnerError(502,'Background export replay boundary changed.');
    };
    while(true){inspectEvidence(page);if(page.records.length){yield (count?',':'')+page.records.map(row=>JSON.stringify(row)).join(',');count+=page.records.length;}if(page.complete)break;page=await next(page.nextCursor);}
    yield '],"observations":[';
    const seen=new Set<string>();page=first;
    while(true){inspectEvidence(page);const rows=page.observations.filter(row=>{if(seen.has(row.id))return false;seen.add(row.id);return true;});if(rows.length){yield (observations?',':'')+rows.map(row=>JSON.stringify(row)).join(',');observations+=rows.length;}if(page.complete)break;page=await next(page.nextCursor);}
    yield `],"recordCount":${count},"observationCount":${observations},"missingObservationIds":${JSON.stringify([...missing])},"pageEvidenceComplete":${evidenceComplete&&missing.size===0},"truncated":false}`;
  }
  const iterator=chunks(),encoder=new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({async pull(controller){try{const row=await iterator.next();if(row.done)controller.close();else controller.enqueue(encoder.encode(row.value));}catch(error){controller.error(error);}},async cancel(){await iterator.return(undefined);}}),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Disposition':'attachment; filename="dugout-paper-runner-history.json"'}});
}
/** null means verified browser-owned mode only. Frozen/active errors never fall back. */
export async function proxyRunnerSession(request:Request,database:RunnerDatabase,env:RunnerBindings,action?:TennisAction):Promise<Response|null>{
  const owner=requireSitesOwner(request),fence=await readOwnerFence(database,owner);
  if(!fence)return null;
  if(action)requireRunnerOrigin(request);
  if(fence.mode==='frozen'){
    if(action||new URL(request.url).searchParams.get('export')==='1')throw new RunnerError(409,'History is moving to the background runner. Trading is paused; continue the saved migration.');
    return Response.json({session:JSON.parse(fence.snapshot),runtime:{mode:'migrating',intervalMs:2500,backgroundConnected:false,streamConfigured:!!polymarketSecrets(env as Record<string,unknown>),description:'History migration is paused safely between resumable steps.'}},{headers:{'Cache-Control':'no-store'}});
  }
  if(new URL(request.url).searchParams.get('export')==='1')return runnerExport(env,fence);
  // Older open browser tabs may still post ticks. Read state without duplicating work.
  const state=action&&action.action!=='tick'
    ?await runnerStateText(env,owner,fence.epoch,'/v1/command','POST',{command:action})
    :await runnerStateText(env,owner,fence.epoch,'/v1/state');
  return sessionResponse(state,env);
}
