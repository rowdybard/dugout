export type SportsSourceFailure={endpoint:string;status:number|null;receivedAt:number;retryAt:number;kind:'http'|'network'|'invalid_json';title?:string;denial?:'network_policy'|'access_denied'};
export class SportsSourceError extends Error{
  readonly failure:SportsSourceFailure;
  constructor(failure:SportsSourceFailure){
    const label=failure.status===403?'The sports-data request was rejected (HTTP 403)':failure.status===429?'The sports provider requested a pause (HTTP 429)':'The sports source is temporarily unavailable';
    super(`${label}. Next source check after ${new Date(failure.retryAt).toISOString()}.`);
    this.name='SportsSourceError';
    this.failure=failure;
  }
}
export function retryTime(status:number|null,retryAfter:string|null,now:number){
  const minimum=status===403?300000:status===429?30000:15000;
  const value=retryAfter?.trim();
  const requested=value?( /^\d+(\.\d+)?$/.test(value)?now+Number(value)*1000:Date.parse(value)):NaN;
  return Math.max(now+minimum,Number.isFinite(requested)&&requested<=8640000000000000?requested:0);
}
type Dependencies={fetch:typeof fetch;now:()=>number;readBlock:(host:string)=>Promise<SportsSourceFailure|null>;writeBlock:(host:string,failure:SportsSourceFailure)=>Promise<void>};
/** Failed public sources are cooled down across requests; failures never become game data. */
export function createSportsReader(deps:Dependencies){
  return async (url:string,signal:AbortSignal):Promise<unknown>=>{
    signal.throwIfAborted();
    const host=new URL(url).hostname,blocked=await deps.readBlock(host);
    if(blocked&&Number.isFinite(blocked.retryAt)&&blocked.retryAt>deps.now())throw new SportsSourceError(blocked);
    const fail=async(failure:SportsSourceFailure):Promise<never>=>{await deps.writeBlock(host,failure).catch(()=>{});throw new SportsSourceError(failure);};
    let response:Response;
    try{response=await deps.fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});}
    catch(error){if(signal.aborted)throw error;const receivedAt=deps.now();return fail({endpoint:url,status:null,receivedAt,retryAt:retryTime(null,null,receivedAt),kind:'network'});}
    if(!response.ok){
      const body=(await response.text()).slice(0,4096),receivedAt=deps.now();
      const title=body.match(/<title[^>]*>([^<]{1,160})<\/title>/i)?.[1];
      const denial=/network policy|blocked by policy|domain.*not allowed|egress.*denied/i.test(body)?'network_policy':/access denied|accessdenied|request blocked/i.test(body)?'access_denied':undefined;
      return fail({endpoint:url,status:response.status,receivedAt,retryAt:retryTime(response.status,response.headers.get('retry-after'),receivedAt),kind:'http',title,denial});
    }
    try{return await response.json();}
    catch(error){if(signal.aborted)throw error;const receivedAt=deps.now();return fail({endpoint:url,status:response.status,receivedAt,retryAt:retryTime(response.status,null,receivedAt),kind:'invalid_json'});}
  };
}
