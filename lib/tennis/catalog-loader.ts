import {advanceLeagueDiscovery,visibleLeagueMarkets,type DiscoveryDependencies,type LeagueDiscoveryState} from './catalog-discovery.ts';
import type {TennisCatalog,TennisLeague,TennisMarket} from './types';

type Saved<T>={value:T;updated:number};
type State=LeagueDiscoveryState<TennisMarket>;
export type CatalogDependencies=DiscoveryDependencies<TennisMarket>&{
  read:<T>(key:string)=>Promise<Saved<T>|null>;
  /** One atomic batch: verified mappings plus checkpoint. False means another request won its CAS. */
  writeLeague:(key:string,state:State,expectedUpdated:number|null,fresh:TennisMarket[])=>Promise<boolean>;
  writeCatalog:(key:string,catalog:TennisCatalog,expectedUpdated:number|null)=>Promise<boolean>;
};
export type CatalogLimits={budgetMs?:number;readMs?:number;pageMs?:number;writeMs?:number;cacheTtlMs?:number;maxPages?:number};
const errorText=(error:unknown)=>error instanceof Error?error.message:'Game discovery is temporarily unavailable.';
const keyFor=(league:TennisLeague)=>`paper-sports:discovery:v1:${league}`;
const visible=(markets:TennisMarket[],now:number)=>[...new Map(markets.map(m=>[m.slug,m])).values()].filter(m=>{
  const start=Date.parse(m.startTime);return !m.ended&&Number.isFinite(start)&&start<=now+48*60*60_000&&start>=now-30*60*60_000;
}).sort((a,b)=>Number(b.live)-Number(a.live)||Date.parse(a.startTime)-Date.parse(b.startTime)||a.slug.localeCompare(b.slug));

/**
 * Which refreshed games get their stored copy (`tennis:verified:<slug>`) rewritten. Every refresh observes every game
 * (about 230 college games every 30 s), and rewriting all of them spent the D1 free-plan write limit in a few hours.
 * A game's row is rewritten only when the game itself changed (status, score, clock, rules), or once per 10-minute
 * window so the copy never ages more than that. Prices are not part of the comparison: books are read fresh.
 */
export const VERIFIED_HEARTBEAT_MS=10*60_000;
const VOLATILE=new Set(['observedAt','quoteObservedAt','quoteSource','quoteSourceTime','bid','ask','price','history','rejectedQuoteTimes']);
const gameKey=(market:TennisMarket)=>JSON.stringify(market,(key,value)=>VOLATILE.has(key)?undefined:value);
export function verifiedRowsToWrite(previous:TennisMarket[],fresh:TennisMarket[]):TennisMarket[] {
  const before=new Map(previous.map(market=>[market.slug,market]));
  return fresh.filter(market=>{
    const old=before.get(market.slug);
    return !old||Math.floor(old.observedAt/VERIFIED_HEARTBEAT_MS)!==Math.floor(market.observedAt/VERIFIED_HEARTBEAT_MS)||gameKey(old)!==gameKey(market);
  });
}

/** Bound the complete operation, including D1 calls that cannot accept an AbortSignal. */
export async function boundedCatalogOperation<T>(operation:()=>Promise<T>,deadlineAt:number,now:()=>number,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();const remaining=deadlineAt-now();if(remaining<=0)throw new Error('Game list refresh timed out. Showing saved games.');
  let timer:ReturnType<typeof setTimeout>|undefined,cancel:(()=>void)|undefined;
  const stopped=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('Game list refresh timed out. Showing saved games.')),remaining);
    cancel=()=>reject(signal?.reason??new Error('Game list refresh was cancelled. Showing saved games.'));
    signal?.addEventListener('abort',cancel,{once:true});
  });
  try{return await Promise.race([operation(),stopped]);}
  finally{if(timer)clearTimeout(timer);if(cancel)signal?.removeEventListener('abort',cancel);}
}

/** Request-owned discovery only. Never retain an in-flight promise after its request ends. */
export async function loadTennisCatalog(leagues:TennisLeague[],deps:CatalogDependencies,signal?:AbortSignal,limits:CatalogLimits={}):Promise<TennisCatalog>{
  const startedAt=deps.now(),deadlineAt=startedAt+Math.min(5500,limits.budgetMs??5500),readMs=limits.readMs??750,writeMs=limits.writeMs??1000;
  const key=`paper-sports:catalog:v3:${[...leagues].sort().join(',')}`;
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason??new Error('Game list refresh cancelled.'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const deadlineTimer=setTimeout(()=>controller.abort(new Error('Game list refresh timed out. Showing saved games.')),Math.max(0,deadlineAt-deps.now()));
  const errors:string[]=[],states=new Map<TennisLeague,State>();
  let saved:Saved<TennisCatalog>|null=null;
  const bounded=<T>(operation:()=>Promise<T>,duration:number)=>boundedCatalogOperation(operation,Math.min(deadlineAt,deps.now()+duration),deps.now,controller.signal);
  const compose=(extra?:string):TennisCatalog=>{
    const all:TennisMarket[]=[],pending:TennisLeague[]=[],times:number[]=[],attempts:number[]=[];
    const issues=[...errors,...(extra?[extra]:[])];
    for(const league of leagues){
      const state=states.get(league);
      if(!state||state.status!=='complete'||state.error){pending.push(league);all.push(...(saved?.value.markets??[]).filter(m=>m.league===league));}
      if(state){all.push(...visibleLeagueMarkets(state));if(state.lastPageAt!==null)times.push(state.lastPageAt);if(state.error)issues.push(`${league}: ${state.error}`);attempts.push(state.nextAttemptAt||deps.now()+1000);}
      else attempts.push(deps.now()+5000);
    }
    if(pending.length&&!issues.length)issues.push('Game discovery is still loading. Showing saved games while the next pages are checked.');
    if(issues.length)for(const league of leagues)if(!pending.includes(league))pending.push(league);
    return {markets:visible(all,deps.now()),updatedAt:Math.max(saved?.value.updatedAt??0,...times),errors:[...new Set(issues)],
      discovery:{complete:pending.length===0,pendingLeagues:pending,nextRefreshAt:Math.max(deps.now()+1000,Math.min(...attempts))}};
  };
  try{
    try{saved=await bounded(()=>deps.read<TennisCatalog>(key),readMs);}catch(error){errors.push(errorText(error));}
    if(controller.signal.aborted)return compose(errorText(controller.signal.reason));
    if(saved&&deps.now()-saved.updated<(limits.cacheTtlMs??1000))return {...saved.value,markets:visible(saved.value.markets,deps.now())};
    await bounded(async()=>{
      await Promise.all(leagues.map(async league=>{
        const stateKey=keyFor(league);let previous:Saved<State>|null=null;
        try{
          previous=await bounded(()=>deps.read<State>(stateKey),readMs);
          if(previous)states.set(league,previous.value);
          if(previous&&deps.now()<previous.value.nextAttemptAt)return;
          // Reserve time for the atomic checkpoint and outer response; resume from its cursor next request.
          const pageDeadline=Math.min(deadlineAt-Math.min(1250,(deadlineAt-startedAt)/4),deps.now()+(limits.pageMs??2750));
          const state=await advanceLeagueDiscovery(previous?.value,league,deps,{deadlineAt:pageDeadline,signal:controller.signal,maxPages:Math.max(1,Math.min(2,limits.maxPages??2))});
          controller.signal.throwIfAborted();
          const fresh=verifiedRowsToWrite(previous?visibleLeagueMarkets(previous.value):[],visibleLeagueMarkets(state).filter(m=>m.observedAt>(previous?.value.lastPageAt??0)));
          const committed=await bounded(()=>deps.writeLeague(stateKey,state,previous?.updated??null,fresh),writeMs);
          if(committed)states.set(league,state);
          else{
            const winner=await bounded(()=>deps.read<State>(stateKey),readMs);
            if(winner)states.set(league,winner.value);
            else throw new Error('Another discovery request changed this checkpoint. Retrying shortly.');
          }
        }catch(error){errors.push(`${league}: ${errorText(error)}`);}
      }));
    },deadlineAt-deps.now());
    controller.signal.throwIfAborted();
    const catalog=compose();
    try{await bounded(()=>deps.writeCatalog(key,catalog,saved?.updated??null),writeMs);}
    catch(error){return compose(errorText(error));}
    return catalog;
  }catch(error){return compose(errorText(error));}
  finally{clearTimeout(deadlineTimer);signal?.removeEventListener('abort',abort);controller.abort(new Error('Game list request finished.'));}
}
