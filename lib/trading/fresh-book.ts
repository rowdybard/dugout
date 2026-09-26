import {publicRetryAfterMs} from '../bot/public-source-budget.ts';

export type RestBookReceipt={requestedAt:number;receivedAt:number;cacheStatus:string;cacheAgeSeconds:number|null};
type Dependencies={fetcher?:(url:string,init:RequestInit)=>Promise<Response>;now?:()=>number;nonce?:()=>string};
const MAX_BYTES=1_000_000;

/** One request, called inside the shared source budget. No retries or cached confirmations. */
export async function fetchFreshMarketBook(slug:string,signal?:AbortSignal,dependencies:Dependencies={}){
  if(!/^[-a-zA-Z0-9]{1,200}$/.test(slug))throw new Error('Choose a verified game market.');
  const fetcher=dependencies.fetcher??fetch,now=dependencies.now??Date.now;
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
  requestSignal.throwIfAborted();
  const nonce=(dependencies.nonce??(()=>crypto.randomUUID()))();
  const url=`https://gateway.polymarket.us/v1/markets/${encodeURIComponent(slug)}/book?dugout_read=${encodeURIComponent(nonce)}`;
  const requestedAt=now();
  const response=await fetcher(url,{cache:'no-store',signal:requestSignal});
  if(requestSignal.aborted){await response.body?.cancel().catch(()=>{});requestSignal.throwIfAborted();}
  if(!response.ok){
    await response.body?.cancel().catch(()=>{});
    throw Object.assign(new Error(`Polymarket US returned ${response.status}.`),{status:response.status,retryAfterMs:publicRetryAfterMs(response.headers.get('Retry-After'),now())});
  }
  const cacheStatus=response.headers.get('CF-Cache-Status')?.trim().toUpperCase()??'';
  const age=response.headers.get('Age');
  if(!['MISS','BYPASS','DYNAMIC'].includes(cacheStatus)||age!==null&&(!/^0+$/.test(age.trim()))){
    await response.body?.cancel().catch(()=>{});
    throw new Error('The quote provider returned a cached or unverifiable book. Waiting for a fresh quote.');
  }
  const reader=response.body?.getReader();
  if(!reader)throw new Error('The quote provider returned an empty book response.');
  const decoder=new TextDecoder();let text='',bytes=0;
  try{
    while(true){
      requestSignal.throwIfAborted();
      const part=await reader.read();
      if(part.done)break;
      bytes+=part.value.byteLength;
      if(bytes>MAX_BYTES)throw new Error('The quote provider returned an oversized book response.');
      text+=decoder.decode(part.value,{stream:true});
    }
    text+=decoder.decode();
    requestSignal.throwIfAborted();
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
  const receivedAt=now();
  if(!Number.isFinite(requestedAt)||!Number.isFinite(receivedAt)||receivedAt<requestedAt)throw new Error('The quote observation time could not be verified.');
  const receipt:RestBookReceipt={requestedAt,receivedAt,cacheStatus,cacheAgeSeconds:age===null?null:0};
  return {data:JSON.parse(text) as unknown,receipt};
}
