import {normalizeTennisEvent} from './normalize.ts';
import {assessFootballContext,footballDriveVersion,isFootballMarket} from './football-context.ts';
import {loadEspnContext,footballReportsWithFallback,type EspnContextCache,type EspnSummaryFetcher} from './football-fallback.ts';
import {espnFootballMapping} from './espn-football.ts';
import {retainFootballScore} from './football-score.ts';
import type {FootballAssessment,FootballReportState,TennisMarket} from './types';

export const PRIORITY_CONTEXT_TTL_MS=3000;
export const PRIORITY_CONTEXT_TIMEOUT_MS=3000;
export type PriorityContextRecord={fetchedAt:number;successfulCheckAt?:number|null;market:TennisMarket;reportMarket:TennisMarket;state:FootballReportState;error:string|null;espn?:EspnContextCache};
export type PriorityContextResult=PriorityContextRecord&{successfulCheckAt:number|null;assessment:FootballAssessment;cacheHit:boolean};
export type PriorityContextDependencies={
  now:()=>number;
  read:(key:string)=>Promise<PriorityContextRecord|null>;
  write:(key:string,value:PriorityContextRecord)=>Promise<void>;
  /** Inject the existing provider budget/backoff client. This is a public GET, never an order. */
  fetchEvent:(path:string,signal:AbortSignal)=>Promise<unknown>;
  fetchEspn?:EspnSummaryFetcher;
  timeoutMs?:number;
  /** How long a saved report is reused (default PRIORITY_CONTEXT_TTL_MS); longer for games well before kickoff. */
  ttlMs?:number;
};
const message=(e:unknown)=>e instanceof Error?e.message:'The current game report is unavailable.';
const sameGame=(a:TennisMarket,b:TennisMarket)=>a.slug===b.slug&&a.eventId===b.eventId&&a.eventSlug===b.eventSlug&&a.league===b.league&&a.yesName===b.yesName&&a.noName===b.noName&&
  (!a.footballIdentity||!!b.footballIdentity&&a.footballIdentity.yesTeamId===b.footballIdentity.yesTeamId&&a.footballIdentity.noTeamId===b.footballIdentity.noTeamId);
const orderedDisplayDrive=(next:TennisMarket,previous:TennisMarket)=>{
  const before=previous.footballSources?.drive,after=next.footballSources?.drive;
  if(!after)return false;
  if(!before||before.provider!==after.provider||before.eventId!==after.eventId)return true;
  if(after.reportTime<before.reportTime||after.receiptTime<before.receiptTime||after.sequence!==undefined&&before.sequence!==undefined&&after.sequence<before.sequence)return false;
  return footballDriveVersion(before)!==footballDriveVersion(after)||JSON.stringify(previous.football)===JSON.stringify(next.football);
};
const lastSuccessfulCheck=(record:PriorityContextRecord|null,now:number):number|null=>{
  // Legacy records have no proof of an uncached provider check; wait for the next one.
  const value=record?.successfulCheckAt??null;
  return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=now?value:null;
};
const result=(record:PriorityContextRecord,now:number,cacheHit:boolean):PriorityContextResult=>{
  const state=assessFootballContext(record.reportMarket,now,record.state);
  return {...record,state,successfulCheckAt:lastSuccessfulCheck(record,now),assessment:state.assessment,cacheHit};
};
const unavailable=(market:TennisMarket,previous:PriorityContextRecord|null,now:number,error:string):PriorityContextRecord=>{
  const accepted=previous?.market??market;
  // Unknown context blocks context-based entries without touching quotes or ordinary risk exits.
  const reportMarket={...accepted,football:null,footballSourceIssue:error};
  return {fetchedAt:now,successfulCheckAt:lastSuccessfulCheck(previous,now),market:accepted,reportMarket,state:assessFootballContext(reportMarket,now,previous?.state),error,...(previous?.espn?{espn:previous.espn}:{})};
};

/** Official get-events filters select one event and its full-game winner market.
 * The provider may cache this endpoint; eventState.updatedAt remains authoritative.
 * Actual successful receipt time is reported separately and never refreshes game facts.
 */
export async function loadPriorityContext(market:TennisMarket,deps:PriorityContextDependencies,signal?:AbortSignal):Promise<PriorityContextResult>{
  if(!isFootballMarket(market)){
    const record={fetchedAt:market.observedAt,successfulCheckAt:null,market,reportMarket:market,state:assessFootballContext(market,deps.now()),error:null};
    return result(record,deps.now(),true);
  }
  const key=`tennis:priority-context:v1:${market.eventId}:${market.slug}`;
  let previous:PriorityContextRecord|null=null;
  let latestEspn:EspnContextCache|undefined;
  try{
    const saved=await deps.read(key);
    if(saved&&sameGame(market,saved.market)&&sameGame(market,saved.reportMarket))previous=saved;
    const now=deps.now();
    if(previous&&Number.isFinite(previous.fetchedAt)&&previous.fetchedAt<=now&&now-previous.fetchedAt<(deps.ttlMs??PRIORITY_CONTEXT_TTL_MS))return result(previous,now,true);
    if(!/^[1-9]\d{0,19}$/.test(market.eventId))throw new Error('A verified numeric event ID is required for the current game report.');
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
    let raw:unknown,receivedAt:number,espn:EspnContextCache|undefined;
    try{
      const backup=deps.fetchEspn?loadEspnContext(market,previous?.espn,deps.fetchEspn,deps.now,AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,timeoutMs-100))])).then(value=>{latestEspn=value;return value;}):Promise.resolve(undefined);
      const primary=deps.fetchEvent('/v1/events?id='+encodeURIComponent(market.eventId)+'&sportsMarketTypes=football_team_full_game_winner',controller.signal)
        .then(data=>({data,receivedAt:deps.now()}),error=>({error,receivedAt:deps.now()}));
      const [response,alternative]=await Promise.race([Promise.all([primary,backup]),deadline]);
      if('error' in response)throw response.error;
      raw=response.data;receivedAt=response.receivedAt;espn=alternative;
    }
    finally{if(timer)clearTimeout(timer);if(cancel)signal?.removeEventListener('abort',cancel);}
    signal?.throwIfAborted();
    const events=raw&&typeof raw==='object'&&'events' in raw?(raw as {events:unknown}).events:null;
    if(!Array.isArray(events)||events.length!==1)throw new Error('The current report did not return exactly one verified event.');
    const event=events[0];
    const candidates=normalizeTennisEvent(event,market.league,receivedAt).filter(candidate=>sameGame(market,candidate));
    if(candidates.length!==1||!candidates[0].footballIdentity?.yesTeamId||!candidates[0].footballIdentity.noTeamId||candidates[0].footballIdentity.yesTeamId===candidates[0].footballIdentity.noTeamId)throw new Error('The current report did not match this game and its explicit team identities.');
    const checkedAt=deps.now();
    const composed=deps.fetchEspn?footballReportsWithFallback(candidates[0],espn,checkedAt):{reportMarket:candidates[0],displayMarket:candidates[0]};
    let reportMarket=composed.reportMarket;
    // Another caller may have accepted a newer provider report while this request was in flight.
    const latest=await deps.read(key);
    if(latest&&sameGame(market,latest.market)&&sameGame(market,latest.reportMarket)&&(!previous||latest.fetchedAt>previous.fetchedAt))previous=latest;
    reportMarket=retainFootballScore(reportMarket,previous?.market);
    const state=assessFootballContext(reportMarket,checkedAt,previous?.state??assessFootballContext(market,checkedAt));
    const oldMarket=previous?.market??market;
    const ordered=reportMarket.contextUpdatedAt!==null&&Number.isFinite(reportMarket.contextUpdatedAt)&&reportMarket.contextUpdatedAt<=receivedAt&&
      (oldMarket.contextUpdatedAt===null||reportMarket.contextUpdatedAt>=oldMarket.contextUpdatedAt)&&reportMarket.observedAt>=oldMarket.observedAt;
    // Conflicts remain visible to the engine through reportMarket; the field display keeps its last consistent facts.
    let accepted=ordered&&state.assessment.status!=='conflicting'?reportMarket:oldMarket;
    const acceptedScoreboard=state.scoreboard?.reportTime===reportMarket.contextUpdatedAt&&state.scoreboard?.receiptTime===reportMarket.observedAt;
    if(ordered&&acceptedScoreboard&&(reportMarket.footballSourceIssue||state.assessment.status==='conflicting')&&oldMarket.football&&oldMarket.footballSources){
      // Display last-known drive details with their original evidence; engine receives reportMarket, never this retained view.
      accepted={...reportMarket,football:oldMarket.football,footballSourceIssue:reportMarket.footballSourceIssue??state.assessment.reason,footballSources:{...oldMarket.footballSources,
        scoreboard:{provider:'POLYMARKET',eventId:reportMarket.eventId,reportTime:reportMarket.contextUpdatedAt!,receiptTime:reportMarket.observedAt}}};
    }
    if(ordered&&state.assessment.status!=='conflicting'&&composed.displayMarket!==composed.reportMarket&&orderedDisplayDrive(composed.displayMarket,oldMarket)){
      // A correctly identified delayed play can inform the field without ever reaching an entry check.
      accepted={...composed.displayMarket,footballLastScore:reportMarket.footballLastScore};
    }
    const record:PriorityContextRecord={fetchedAt:checkedAt,successfulCheckAt:receivedAt,market:accepted,reportMarket,state,error:reportMarket.footballSourceIssue?espn?.error??null:null,...(espn?{espn}:{})};
    await deps.write(key,record);
    return {...record,successfulCheckAt:receivedAt,assessment:state.assessment,cacheHit:false};
  }catch(error){
    const record={...unavailable(market,previous,deps.now(),message(error)),...(latestEspn?{espn:latestEspn}:{})};
    if(!signal?.aborted)await deps.write(key,record).catch(()=>{});
    return {...record,successfulCheckAt:lastSuccessfulCheck(record,deps.now()),assessment:record.state.assessment,cacheHit:false};
  }
}

/** Attach context while retaining executable book identity, price, fee rules and receipt evidence. */
export function marketWithPriorityReport(stored:TennisMarket,report:PriorityContextResult):TennisMarket{
  const latest=report.reportMarket;if(!sameGame(stored,latest))return stored;
  return {...stored,live:latest.live,ended:latest.ended,active:stored.active&&latest.active,
    score:latest.score,period:latest.period,clock:latest.clock,football:latest.football,footballIdentity:latest.footballIdentity,tournament:latest.tournament,
    footballSources:latest.footballSources,footballSourceIssue:latest.footballSourceIssue,
    footballLastScore:latest.footballLastScore,
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
  if(ready)return {...book,market:marketWithPriorityReport(book.market,ready)};
  if(espnFootballMapping(book.market))return {...book,market:{...book.market,football:null,footballSourceIssue:'Waiting for the current Polymarket and ESPN game reports. Exits continue.'}};
  return requireReport&&isFootballMarket(book.market)?{...book,market:{...book.market,football:null}}:book;
}
