import {abortable} from './request-budget.ts';

function pause(ms:number,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
    signal?.addEventListener('abort',abort,{once:true});
  });
}

/** Worker requests may share pacing timestamps, never promises tied to another
 * request's fetch, timer or D1 operation. The DO's serialized budget is separate.
 */
export function createServerPublicSourceBudget(options:{spacingMs?:number;now?:()=>number;delay?:(ms:number,signal?:AbortSignal)=>Promise<void>;minBackoffMs?:number;defaultBackoffMs?:number}={}){
  const now=options.now??(()=>Date.now()),delay=options.delay??pause,spacing=options.spacingMs??750;
  const minBackoff=options.minBackoffMs??60000,defaultBackoff=options.defaultBackoffMs??120000;
  let nextAt=0,blockedUntil=0;
  async function run<T>(request:()=>Promise<T>,signal?:AbortSignal,lifecycle:{onBackoff?:(until:number)=>Promise<void>;retain?:(task:Promise<unknown>)=>void}={}):Promise<T>{
    // Claim one start slot without awaiting between the time check and update.
    // Every waking waiter rechecks: late timers cannot dispatch a burst, and
    // abandoned waiters do not reserve an ever-growing queue of future slots.
    while(true){
      signal?.throwIfAborted();
      const time=now();
      if(time<blockedUntil)throw new Error(`Polymarket US requested a pause. Retry after ${new Date(blockedUntil).toISOString()}.`);
      const wait=nextAt-time;
      if(wait>0){await abortable(delay(wait,signal),signal);continue;}
      nextAt=time+spacing;break;
    }
    signal?.throwIfAborted();
    // Classify the underlying request before racing the caller's cancellation.
    // A late 429 must still block new reads and persist its provider deadline.
    const task=(async()=>{try{return await request();}catch(error){
      const value=error as {status?:number;message?:string;retryAfterMs?:number};
      if(value.status===429||/1015|rate.?limit/i.test(value.message??'')){
        const retry=Number.isFinite(value.retryAfterMs)?Math.max(minBackoff,value.retryAfterMs!):defaultBackoff;
        blockedUntil=Math.max(blockedUntil,now()+retry);
        await lifecycle.onBackoff?.(blockedUntil);
        throw new Error(`Polymarket US rate limit. Requests paused until ${new Date(blockedUntil).toISOString()}.`);
      }
      if(value.status)throw new Error(`Polymarket US returned HTTP ${value.status}. No current quote was accepted.`);
      throw error;
    }})();
    lifecycle.retain?.(task.then(()=>undefined,()=>undefined));
    return abortable(task,signal);
  }
  return {run,blockedUntil:()=>blockedUntil,deferUntil:(time:number)=>{if(Number.isFinite(time))blockedUntil=Math.max(blockedUntil,time);}};
}
