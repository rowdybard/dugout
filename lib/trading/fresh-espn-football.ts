import {publicRetryAfterMs} from '../bot/public-source-budget.ts';

export type EspnFootballReceipt={requestedAt:number;receivedAt:number};
type Dependencies={fetcher?:(url:string,init:RequestInit)=>Promise<Response>;now?:()=>number;nonce?:()=>string;timeoutMs?:number};
const MAX_BYTES=2_000_000;

function abortable<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

/** Bounded read-only transport. Receipt time never substitutes for ESPN's own report timestamp. */
export async function fetchFreshEspnFootballSummary(eventId:string,signal?:AbortSignal,dependencies:Dependencies={}){
  if(!/^[1-9]\d{0,19}$/.test(eventId))throw new Error('Choose a verified numeric ESPN event ID.');
  const fetcher=dependencies.fetcher??fetch,now=dependencies.now??Date.now;
  const timeout=AbortSignal.timeout(Math.max(1,Math.min(3000,dependencies.timeoutMs??3000)));
  const requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;requestSignal.throwIfAborted();
  const nonce=(dependencies.nonce??(()=>crypto.randomUUID()))();
  const url=`https://site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=${encodeURIComponent(eventId)}&dugout_read=${encodeURIComponent(nonce)}`;
  const requestedAt=now();
  const pending=fetcher(url,{cache:'no-store',redirect:'manual',headers:{'Cache-Control':'no-cache',Pragma:'no-cache'},signal:requestSignal});
  void pending.then(response=>{if(requestSignal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
  const response=await abortable(pending,requestSignal);
  if(!response.ok){
    void response.body?.cancel().catch(()=>{});
    throw Object.assign(new Error(`ESPN returned ${response.status}.`),{status:response.status,retryAfterMs:publicRetryAfterMs(response.headers.get('Retry-After'),now())});
  }
  requestSignal.throwIfAborted();
  const reader=response.body?.getReader();if(!reader)throw new Error('ESPN returned an empty game response.');
  const decoder=new TextDecoder();let text='',bytes=0;
  try{
    while(true){
      requestSignal.throwIfAborted();const part=await abortable(reader.read(),requestSignal);if(part.done)break;
      bytes+=part.value.byteLength;if(bytes>MAX_BYTES)throw new Error('ESPN returned an oversized game response.');
      text+=decoder.decode(part.value,{stream:true});
    }
    text+=decoder.decode();requestSignal.throwIfAborted();
  }catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  const receivedAt=now();
  if(!Number.isFinite(requestedAt)||!Number.isFinite(receivedAt)||requestedAt<0||receivedAt<requestedAt)throw new Error('The ESPN receipt time could not be verified.');
  const receipt:EspnFootballReceipt={requestedAt,receivedAt};
  return {data:JSON.parse(text) as unknown,receipt};
}
