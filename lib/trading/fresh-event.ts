import {publicRetryAfterMs} from '../bot/public-source-budget.ts';

export type FreshEventReceipt={requestedAt:number;receivedAt:number;cacheStatus:string;cacheAgeSeconds:number|null};
type Dependencies={fetcher?:(url:string,init:RequestInit)=>Promise<Response>;now?:()=>number;nonce?:()=>string};
const MAX_BYTES=1_000_000;

/** One compact public winner-event request, inside the existing source budget/backoff. No retries. */
async function fetchFreshWinnerEvent(eventId:string,winnerType:'football_team_full_game_winner'|'tennis_match_winner',sport:'football'|'tennis',signal?:AbortSignal,dependencies:Dependencies={}){
  if(!/^[1-9]\d{0,19}$/.test(eventId))throw new Error(`Choose a verified numeric ${sport} event ID.`);
  const fetcher=dependencies.fetcher??fetch,now=dependencies.now??Date.now;
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000);
  requestSignal.throwIfAborted();
  const nonce=(dependencies.nonce??(()=>crypto.randomUUID()))();
  const url=`https://gateway.polymarket.us/v1/events?id=${encodeURIComponent(eventId)}&sportsMarketTypes=${winnerType}&dugout_read=${encodeURIComponent(nonce)}`;
  const requestedAt=now();
  const response=await fetcher(url,{cache:'no-store',signal:requestSignal});
  if(!response.ok){
    await response.body?.cancel().catch(()=>{});
    throw Object.assign(new Error(`Polymarket US returned ${response.status}.`),{status:response.status,retryAfterMs:publicRetryAfterMs(response.headers.get('Retry-After'),now())});
  }
  if(requestSignal.aborted){await response.body?.cancel().catch(()=>{});requestSignal.throwIfAborted();}
  const cacheStatus=response.headers.get('CF-Cache-Status')?.trim().toUpperCase()??'';
  const age=response.headers.get('Age');
  // EXPIRED and REVALIDATED were checked with the origin on this request, so they are current too.
  if(!['MISS','BYPASS','DYNAMIC','EXPIRED','REVALIDATED'].includes(cacheStatus)||age!==null&&(!/^0+$/.test(age.trim()))){
    await response.body?.cancel().catch(()=>{});
    throw new Error('The game-report provider returned a cached or unverifiable report. Waiting for a fresh source check.');
  }
  const reader=response.body?.getReader();
  if(!reader)throw new Error('The game-report provider returned an empty report response.');
  const decoder=new TextDecoder();let text='',bytes=0;
  try{
    while(true){
      requestSignal.throwIfAborted();
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>MAX_BYTES)throw new Error('The game-report provider returned an oversized report response.');
      text+=decoder.decode(part.value,{stream:true});
    }
    text+=decoder.decode();
    requestSignal.throwIfAborted();
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  const receivedAt=now();
  if(!Number.isFinite(requestedAt)||!Number.isFinite(receivedAt)||receivedAt<requestedAt)throw new Error('The game-report receipt time could not be verified.');
  const receipt:FreshEventReceipt={requestedAt,receivedAt,cacheStatus,cacheAgeSeconds:age===null?null:0};
  return {data:JSON.parse(text) as unknown,receipt};
}

export function fetchFreshFootballEvent(eventId:string,signal?:AbortSignal,dependencies:Dependencies={}){
  return fetchFreshWinnerEvent(eventId,'football_team_full_game_winner','football',signal,dependencies);
}
export function fetchFreshTennisEvent(eventId:string,signal?:AbortSignal,dependencies:Dependencies={}){
  return fetchFreshWinnerEvent(eventId,'tennis_match_winner','tennis',signal,dependencies);
}
