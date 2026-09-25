/** Conservative per-process pacing; server adapters also persist provider backoff. */
export function createPublicSourceBudget(options:{spacingMs?:number;now?:()=>number;delay?:(ms:number)=>Promise<void>}={}){
  const now=options.now??Date.now,delay=options.delay??(ms=>new Promise(resolve=>setTimeout(resolve,ms))),spacing=options.spacingMs??750;
  let tail:Promise<unknown>=Promise.resolve(),nextAt=0,blockedUntil=0;
  async function run<T>(request:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    const result=tail.then(async()=>{
      signal?.throwIfAborted();
      if(now()<blockedUntil)throw new Error(`Polymarket US requested a pause. Retry after ${new Date(blockedUntil).toISOString()}.`);
      const wait=nextAt-now();if(wait>0)await delay(wait);
      signal?.throwIfAborted();
      nextAt=now()+spacing;
      try{return await request();}
      catch(error){
        const value=error as {status?:number;message?:string;retryAfterMs?:number};
        if(value.status===429||/1015|rate.?limit/i.test(value.message??'')){
          const retry=Number.isFinite(value.retryAfterMs)?Math.max(60000,value.retryAfterMs!):120000;
          blockedUntil=now()+retry;
          throw new Error(`Polymarket US rate limit. Requests paused until ${new Date(blockedUntil).toISOString()}.`);
        }
        if(value.status)throw new Error(`Polymarket US returned HTTP ${value.status}. No current quote was accepted.`);
        throw error;
      }
    });
    tail=result.catch(()=>{});return result;
  }
  return {run,blockedUntil:()=>blockedUntil,deferUntil:(time:number)=>{if(Number.isFinite(time))blockedUntil=Math.max(blockedUntil,time);}};
}
