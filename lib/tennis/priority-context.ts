import {normalizeTennisEvent} from './normalize.ts';
import {assessFootballContext,isFootballMarket} from './football-context.ts';
import type {FootballAssessment,FootballReportState,TennisMarket} from './types';

export const PRIORITY_CONTEXT_TTL_MS=3000;
export const PRIORITY_CONTEXT_TIMEOUT_MS=2000;
export type PriorityContextRecord={fetchedAt:number;market:TennisMarket;reportMarket:TennisMarket;state:FootballReportState;error:string|null};
export type PriorityContextResult=PriorityContextRecord&{assessment:FootballAssessment;cacheHit:boolean};
export type PriorityContextDependencies={
  now:()=>number;
  read:(key:string)=>Promise<PriorityContextRecord|null>;
  write:(key:string,value:PriorityContextRecord)=>Promise<void>;
  /** Inject the existing provider budget/backoff client. This is a public GET, never an order. */
  fetchEvent:(path:string,signal:AbortSignal)=>Promise<unknown>;
  timeoutMs?:number;
};
const message=(e:unknown)=>e instanceof Error?e.message:'The current game report is unavailable.';
const sameGame=(a:TennisMarket,b:TennisMarket)=>a.slug===b.slug&&a.eventId===b.eventId&&a.eventSlug===b.eventSlug&&a.league===b.league&&a.yesName===b.yesName&&a.noName===b.noName&&
  (!a.footballIdentity||!!b.footballIdentity&&a.footballIdentity.yesTeamId===b.footballIdentity.yesTeamId&&a.footballIdentity.noTeamId===b.footballIdentity.noTeamId);
const result=(record:PriorityContextRecord,now:number,cacheHit:boolean):PriorityContextResult=>{
  const state=assessFootballContext(record.reportMarket,now,record.state);
  return {...record,state,assessment:state.assessment,cacheHit};
};
const unavailable=(market:TennisMarket,previous:PriorityContextRecord|null,now:number,error:string):PriorityContextRecord=>{
  const accepted=previous?.market??market;
  // Unknown context blocks context-based entries without touching quotes or ordinary risk exits.
  const reportMarket={...accepted,football:null};
  return {fetchedAt:now,market:accepted,reportMarket,state:assessFootballContext(reportMarket,now,previous?.state),error};
};

/** Official US SDK: events.retrieveBySlug → /v1/events/slug/{slug}.
 * https://github.com/Polymarket/polymarket-us-typescript/blob/main/src/resources/events.ts
 * Receipt time comes only from completion of this fetch. Cache reads never refresh either clock.
 */
export async function loadPriorityContext(market:TennisMarket,deps:PriorityContextDependencies,signal?:AbortSignal):Promise<PriorityContextResult>{
  if(!isFootballMarket(market)){
    const record={fetchedAt:market.observedAt,market,reportMarket:market,state:assessFootballContext(market,deps.now()),error:null};
    return result(record,deps.now(),true);
  }
  const key=`tennis:priority-context:v1:${market.eventId}:${market.slug}`;
  let previous:PriorityContextRecord|null=null;
  try{
    const saved=await deps.read(key);
    if(saved&&sameGame(market,saved.market)&&sameGame(market,saved.reportMarket))previous=saved;
    const now=deps.now();
    if(previous&&Number.isFinite(previous.fetchedAt)&&previous.fetchedAt<=now&&now-previous.fetchedAt<PRIORITY_CONTEXT_TTL_MS)return result(previous,now,true);
    if(!/^[a-zA-Z0-9_-]{1,250}$/.test(market.eventSlug))throw new Error('A verified event slug is required for the current game report.');
    signal?.throwIfAborted();
    const controller=new AbortController(),timeoutMs=Math.max(1,Math.min(PRIORITY_CONTEXT_TIMEOUT_MS,deps.timeoutMs??PRIORITY_CONTEXT_TIMEOUT_MS));
    let timer:ReturnType<typeof setTimeout>|undefined;
    let cancel:(()=>void)|undefined;
    const deadline=new Promise<never>((_resolve,reject)=>{
      const stop=(error:unknown)=>{controller.abort(error);reject(error);};
      timer=setTimeout(()=>stop(new Error('The game report took too long. Quote and exit checks continue.')),timeoutMs);
      cancel=()=>stop(signal?.reason??new Error('Game report request cancelled.'));
      signal?.addEventListener('abort',cancel,{once:true});
    });
    let raw:unknown;
    try{raw=await Promise.race([deps.fetchEvent('/v1/events/slug/'+encodeURIComponent(market.eventSlug),controller.signal),deadline]);}
    finally{if(timer)clearTimeout(timer);if(cancel)signal?.removeEventListener('abort',cancel);}
    signal?.throwIfAborted();
    const receivedAt=deps.now(),event=raw&&typeof raw==='object'&&'event' in raw?(raw as {event:unknown}).event:raw;
    const candidates=normalizeTennisEvent(event,market.league,receivedAt).filter(candidate=>sameGame(market,candidate));
    if(candidates.length!==1||!candidates[0].footballIdentity?.yesTeamId||!candidates[0].footballIdentity.noTeamId||candidates[0].footballIdentity.yesTeamId===candidates[0].footballIdentity.noTeamId)throw new Error('The current report did not match this game and its explicit team identities.');
    const reportMarket=candidates[0];
    // Another caller may have accepted a newer provider report while this request was in flight.
    const latest=await deps.read(key);
    if(latest&&sameGame(market,latest.market)&&sameGame(market,latest.reportMarket)&&(!previous||latest.fetchedAt>previous.fetchedAt))previous=latest;
    const state=assessFootballContext(reportMarket,receivedAt,previous?.state??assessFootballContext(market,receivedAt));
    const oldMarket=previous?.market??market;
    const ordered=reportMarket.contextUpdatedAt!==null&&Number.isFinite(reportMarket.contextUpdatedAt)&&reportMarket.contextUpdatedAt<=receivedAt&&
      (oldMarket.contextUpdatedAt===null||reportMarket.contextUpdatedAt>=oldMarket.contextUpdatedAt)&&reportMarket.observedAt>=oldMarket.observedAt;
    // Conflicts remain visible to the engine through reportMarket; the field display keeps its last consistent facts.
    const accepted=ordered&&state.assessment.status!=='conflicting'?reportMarket:oldMarket;
    const record:PriorityContextRecord={fetchedAt:receivedAt,market:accepted,reportMarket,state,error:state.assessment.status==='conflicting'?state.assessment.reason:null};
    await deps.write(key,record);
    return {...record,assessment:state.assessment,cacheHit:false};
  }catch(error){
    const record=unavailable(market,previous,deps.now(),message(error));
    if(!signal?.aborted)await deps.write(key,record).catch(()=>{});
    return {...record,assessment:record.state.assessment,cacheHit:false};
  }
}

/** Attach context while retaining executable book identity, price, fee rules and receipt evidence. */
export function marketWithPriorityReport(stored:TennisMarket,report:PriorityContextResult):TennisMarket{
  const latest=report.reportMarket;if(!sameGame(stored,latest))return stored;
  return {...stored,live:latest.live,ended:latest.ended,active:stored.active&&latest.active,
    score:latest.score,period:latest.period,clock:latest.clock,football:latest.football,footballIdentity:latest.footballIdentity,tournament:latest.tournament,
    observedAt:latest.observedAt,contextUpdatedAt:latest.contextUpdatedAt};
}

/** Held exits wait only for their book. Pending/new entries may require the bounded report check.
 * The caller should keep reportPromise alive with its platform waitUntil when requireReport is false.
 */
export async function joinBookWithPriorityContext<T extends {market:TennisMarket}>(bookPromise:Promise<T>,reportPromise:Promise<PriorityContextResult>,_now:()=>number=Date.now,requireReport=false):Promise<T>{
  // Preserve the adapter's clock argument without using it to refresh recorded source times.
  void _now;
  let ready:PriorityContextResult|undefined;
  const report=reportPromise.then(value=>{ready=value;return value;},()=>undefined);
  const book=await bookPromise;
  if(requireReport)await report;
  return ready?{...book,market:marketWithPriorityReport(book.market,ready)}:requireReport&&isFootballMarket(book.market)?{...book,market:{...book.market,football:null}}:book;
}
