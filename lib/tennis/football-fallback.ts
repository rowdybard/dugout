import {assessFootballContext} from './football-context.ts';
import {espnFootballMapping,normalizeEspnFootballReport,type EspnFootballReport} from './espn-football.ts';
import type {TennisMarket,FootballSources} from './types';

export const ESPN_CONTEXT_TTL_MS=10_000;
export type EspnContextCache={fetchedAt:number;retryAt:number;report?:EspnFootballReport;error?:string};
export type EspnSummaryFetcher=(eventId:string,signal:AbortSignal)=>Promise<{data:unknown;receipt:{receivedAt:number}}>;

async function boundedSummary(fetchSummary:EspnSummaryFetcher,eventId:string,signal:AbortSignal){
  signal.throwIfAborted();
  let cancel:(()=>void)|undefined;
  try{
    return await Promise.race([fetchSummary(eventId,signal),new Promise<never>((_resolve,reject)=>{
      cancel=()=>reject(signal.reason??new Error('The ESPN drive check took too long.'));
      signal.addEventListener('abort',cancel,{once:true});
      if(signal.aborted)cancel();
    })]);
  }finally{if(cancel)signal.removeEventListener('abort',cancel);}
}

/** Separate cache/backoff: a failed backup must never silence the primary clock or prices. */
export async function loadEspnContext(market:TennisMarket,previous:EspnContextCache|undefined,fetchSummary:EspnSummaryFetcher,now:()=>number,signal:AbortSignal):Promise<EspnContextCache|undefined>{
  const mapping=espnFootballMapping(market);
  if(!mapping||market.ended||!market.live)return undefined;
  const startedAt=now();
  if(previous&&previous.fetchedAt<=startedAt&&startedAt<previous.retryAt)return previous;
  try{
    const {data,receipt}=await boundedSummary(fetchSummary,mapping.eventId,signal);
    return {fetchedAt:startedAt,retryAt:startedAt+ESPN_CONTEXT_TTL_MS,report:normalizeEspnFootballReport(data,mapping,receipt.receivedAt)};
  }catch(error){
    const retry=error as {status?:number;retryAfterMs?:number};
    const delay=retry.status===429?Math.max(ESPN_CONTEXT_TTL_MS,retry.retryAfterMs??60_000):ESPN_CONTEXT_TTL_MS;
    return {fetchedAt:startedAt,retryAt:now()+delay,...(previous?.report?{report:previous.report}:{}),error:error instanceof Error?error.message:'ESPN drive details are unavailable.'};
  }
}

/** The primary owns every market/scoreboard field; ESPN can contribute only missing drive facts. */
export function withEspnFootballFallback(market:TennisMarket,cached:EspnContextCache|undefined,now:number):TennisMarket{
  return footballReportsWithFallback(market,cached,now).reportMarket;
}

/** Keep display history separate from entry evidence, including on the very first delayed response. */
export function footballReportsWithFallback(market:TennisMarket,cached:EspnContextCache|undefined,now:number):{reportMarket:TennisMarket;displayMarket:TennisMarket}{
  const same=(value:TennisMarket)=>({reportMarket:value,displayMarket:value});
  const mapping=espnFootballMapping(market);
  if(!mapping)return same(market);
  const primarySource=market.contextUpdatedAt===null?undefined:{provider:'POLYMARKET' as const,eventId:market.eventId,reportTime:market.contextUpdatedAt,receiptTime:market.observedAt};
  const lastScore=cached?.report?.lastScore;
  const scored=lastScore&&lastScore.score===market.score?{...market,footballLastScore:lastScore}:market;
  const native=primarySource?{...scored,footballSources:{scoreboard:primarySource,drive:{...primarySource}}}:scored;
  if(!market.live||market.ended||!market.active||market.football?.phase==='between-plays')return same(native);
  const primary=assessFootballContext(market,now);
  if(primary.assessment.status==='fresh')return same(native);
  // A complete but old primary report is not repaired by borrowing another provider's possession.
  if(primary.report)return same(native);
  const report=cached?.report;
  const missing=(reason:string,sources?:FootballSources)=>same({...native,football:null,footballSourceIssue:reason,...(sources?{footballSources:sources}:{})});
  if(!report)return missing(cached?.error??'Polymarket has not supplied drive details. Waiting for ESPN.');
  const evidence=report.provenance;
  const sources:FootballSources|undefined=market.contextUpdatedAt!==null&&evidence.reportTime!==null?{
    scoreboard:{provider:'POLYMARKET',eventId:market.eventId,reportTime:market.contextUpdatedAt,receiptTime:market.observedAt},
    drive:{provider:'ESPN',eventId:evidence.eventId,reportTime:evidence.reportTime,receiptTime:evidence.receivedAt,
      ...(evidence.playId?{playId:evidence.playId}:{}),...(evidence.sequence!==null?{sequence:evidence.sequence}:{}),
      ...(report.score?{score:report.score}:{}),...(report.period?{period:report.period}:{})},
    mapping:{yesPolymarketTeamId:mapping.yes.polymarketTeamId,noPolymarketTeamId:mapping.no.polymarketTeamId,yesEspnTeamId:mapping.yes.espnTeamId,noEspnTeamId:mapping.no.espnTeamId},
  }:undefined;
  if(cached?.error)return missing(cached.error,sources);
  if(report.status!=='drive'||!report.football)return missing(report.reason??'ESPN is between plays; waiting for a complete drive report.',sources);
  if(!sources)return missing('Waiting for verified timestamps from both game feeds.');
  if(report.score!==market.score||report.period!==market.period)return missing('ESPN drive details do not match the Polymarket score and quarter.',sources);
  const partial=market.football,drive=report.football;
  if(partial&&(partial.possessionTeamId&&partial.possessionTeamId!==drive.possessionTeamId||partial.down!==null&&partial.down!==drive.down||partial.yardsToGo!==null&&partial.yardsToGo!==drive.yardsToGo||partial.fieldPosition&&(partial.fieldPosition.teamId!==drive.fieldPosition?.teamId||partial.fieldPosition.yard!==drive.fieldPosition?.yard)))
    return missing('Polymarket and ESPN disagree about the drive. Waiting for matching reports.',sources);
  const combined={...scored,football:{...drive,timeouts:market.football?.timeouts??[]},footballSources:sources};
  const assessment=assessFootballContext(combined,now);
  if(assessment.assessment.status==='fresh')return same(combined);
  const rejected=missing(assessment.assessment.reason,sources);
  const validTimes=[sources.scoreboard,sources.drive].every(source=>Number.isFinite(source.reportTime)&&Number.isFinite(source.receiptTime)&&source.reportTime>=0&&source.reportTime<=source.receiptTime&&source.receiptTime<=now);
  return validTimes?{...rejected,displayMarket:{...combined,footballSourceIssue:assessment.assessment.reason}}:rejected;
}
