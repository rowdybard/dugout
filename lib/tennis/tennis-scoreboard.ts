import {abortable,sourceError} from '../server/request-budget.ts';
import {normalizeTennisEvent} from './normalize.ts';
import type {TennisMarket} from './types';

export const TENNIS_SCOREBOARD_TTL_MS=5000;
export type TennisScoreboardRecord={fetchedAt:number;successfulCheckAt:number|null;market:TennisMarket;error:string|null};
export type TennisScoreboardResult=TennisScoreboardRecord&{cacheHit:boolean};
export type TennisScoreboardDependencies={
  now:()=>number;
  read:(key:string)=>Promise<TennisScoreboardRecord|null>;
  /** False means the atomic public-cache ordering guard kept a concurrent winner. */
  write:(key:string,value:TennisScoreboardRecord)=>Promise<boolean|void>;
  fetchEvent:(eventId:string,signal:AbortSignal)=>Promise<{data:unknown;receipt:{receivedAt:number}}>;
};
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const participantId=(value:unknown)=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;
const sameGame=(a:TennisMarket,b:TennisMarket)=>a.slug===b.slug&&a.eventId===b.eventId&&a.eventSlug===b.eventSlug&&a.league===b.league&&a.yesName===b.yesName&&a.noName===b.noName&&
  (!a.tennisIdentity||!!b.tennisIdentity&&a.tennisIdentity.yesPlayerId===b.tennisIdentity.yesPlayerId&&a.tennisIdentity.noPlayerId===b.tennisIdentity.noPlayerId);
/** Scores can update game receipts, but never quote receipts, prices or executable rules. */
export function marketWithTennisScoreboard(stored:TennisMarket,snapshot:TennisMarket):TennisMarket{
  return {...snapshot,startTime:stored.startTime,title:stored.title,bid:stored.bid,ask:stored.ask,price:stored.price,execution:stored.execution,
    active:stored.active&&snapshot.active,history:[],quoteObservedAt:stored.quoteObservedAt??stored.observedAt,quoteSource:stored.quoteSource,quoteSourceTime:stored.quoteSourceTime,rejectedQuoteTimes:stored.rejectedQuoteTimes};
}
function publicSnapshot(market:TennisMarket):TennisMarket{
  return {...market,bid:null,ask:null,price:null,history:[],quoteObservedAt:undefined,quoteSource:undefined,quoteSourceTime:undefined,rejectedQuoteTimes:undefined};
}
/** Verify the compact response before any part of it can replace the selected scoreboard. */
export function normalizeSelectedTennisScoreboard(raw:unknown,stored:TennisMarket,receivedAt:number):TennisMarket{
  if(!['ATP','WTA'].includes(stored.league)||!Number.isFinite(receivedAt)||receivedAt<0)throw new Error('Choose a verified ATP or WTA match.');
  const events=object(raw).events;
  if(!Array.isArray(events)||events.length!==1)throw new Error('The tennis report did not return exactly one verified event.');
  const event=object(events[0]),state=object(event.eventState);
  if(String(event.id)!==stored.eventId||event.slug!==stored.eventSlug||state.type!=='tennis'||state.eventId!==undefined&&String(state.eventId)!==stored.eventId)
    throw new Error('The tennis report does not match the selected match.');
  // The aggregate event may lag. Score, period, player state and timestamp use the one eventState snapshot.
  if(typeof state.score!=='string'||typeof state.period!=='string'||typeof state.live!=='boolean'||typeof state.ended!=='boolean')
    throw new Error('The tennis report has no complete authoritative score state.');
  const markets=Array.isArray(event.markets)?event.markets.map(object).filter(m=>m.slug===stored.slug&&m.sportsMarketType==='tennis_match_winner'):[];
  if(markets.length!==1)throw new Error('The tennis report did not identify the selected winner market.');
  const sides=Array.isArray(markets[0].marketSides)?(markets[0].marketSides as unknown[]).map(object):[];
  const yes=sides.filter(side=>side.long===true),no=sides.filter(side=>side.long===false);
  if(sides.length!==2||yes.length!==1||no.length!==1)throw new Error('The tennis report has no verified outcome player mapping.');
  const ids=[yes[0],no[0]].map((side,index)=>{
    const team=object(side.team),id=participantId(team.id);
    if(!id||participantId(side.teamId)!==id||typeof team.league!=='string'||team.league.toUpperCase()!==stored.league||side.description!==[stored.yesName,stored.noName][index]||team.name!==side.description)
      throw new Error('The tennis report player identities or tour changed.');
    return id;
  });
  if(ids[0]===ids[1])throw new Error('The tennis report repeated one player on both outcomes.');
  const candidates=normalizeTennisEvent(event,stored.league,receivedAt).filter(m=>m.slug===stored.slug);
  if(candidates.length!==1)throw new Error('The tennis report could not be normalized for this match.');
  const candidate={...candidates[0],tennisIdentity:{yesPlayerId:ids[0],noPlayerId:ids[1]}};
  if(!sameGame(stored,candidate))throw new Error('The tennis report participant mapping changed.');
  if(candidate.contextUpdatedAt===null||candidate.contextUpdatedAt<0||candidate.contextUpdatedAt>receivedAt)
    throw new Error('The tennis score source time could not be verified.');
  return publicSnapshot(candidate);
}
const scoreFacts=(market:TennisMarket,includeDetails:boolean)=>JSON.stringify([market.score,market.period,market.live,market.ended,...(includeDetails?[market.tennis]:[])]);
const sourceOrder=(a:TennisMarket,b:TennisMarket)=>(a.contextUpdatedAt??-1)-(b.contextUpdatedAt??-1)||a.observedAt-b.observedAt;
const newestMarket=(a:TennisMarket,b:TennisMarket|undefined)=>b&&sourceOrder(b,a)>0?b:a;
/** Select the latest source facts among already verified copies of one selected match. */
export function latestVerifiedTennisScoreboard(markets:(TennisMarket|null|undefined)[]):TennisMarket|undefined{
  const first=markets.find((market):market is TennisMarket=>!!market);
  return first?markets.filter((market):market is TennisMarket=>!!market&&sameGame(first,market)).reduce((latest,market)=>newestMarket(latest,market),first):undefined;
}
const newestRecord=(a:TennisScoreboardRecord|null,b:TennisScoreboardRecord)=>!a||sourceOrder(b.market,a.market)>0||sourceOrder(b.market,a.market)===0&&b.fetchedAt>a.fetchedAt?b:a;

/** Public match cache only: no paper-account initialization, writes or ticks. */
export async function loadTennisScoreboard(market:TennisMarket,deps:TennisScoreboardDependencies,signal?:AbortSignal):Promise<TennisScoreboardResult>{
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(4500)]):AbortSignal.timeout(4500);
  requestSignal.throwIfAborted();
  const key=`tennis:scoreboard:v1:${market.eventId}:${market.slug}`;
  let previous:TennisScoreboardRecord|null=null;
  const result=(record:TennisScoreboardRecord,cacheHit:boolean)=>({...record,market:marketWithTennisScoreboard(market,newestMarket(market,record.market)),cacheHit});
  const readLatest=async()=>{
    const saved=await abortable(deps.read(key),requestSignal);requestSignal.throwIfAborted();
    if(saved&&sameGame(market,saved.market))previous=newestRecord(previous,saved);
  };
  const persist=async(record:TennisScoreboardRecord)=>{
    const accepted=await abortable(deps.write(key,record),requestSignal);requestSignal.throwIfAborted();
    if(accepted===false){await readLatest();if(previous)return result(previous,false);}
    return result(record,false);
  };
  try{
    const saved=await abortable(deps.read(key),requestSignal);requestSignal.throwIfAborted();
    if(saved&&sameGame(market,saved.market))previous=saved;
    const startedAt=deps.now();
    if(previous&&previous.fetchedAt<=startedAt&&startedAt-previous.fetchedAt<TENNIS_SCOREBOARD_TTL_MS)return result(previous,true);
    const {data,receipt}=await abortable(deps.fetchEvent(market.eventId,requestSignal),requestSignal);requestSignal.throwIfAborted();
    const checkedAt=deps.now();
    if(!Number.isFinite(receipt.receivedAt)||receipt.receivedAt<startedAt||receipt.receivedAt>checkedAt)throw new Error('The tennis scoreboard receipt time could not be verified.');
    const candidate=normalizeSelectedTennisScoreboard(data,market,receipt.receivedAt);
    await readLatest();
    const frontier=newestMarket(market,previous?.market);
    if(!sameGame(frontier,candidate)||frontier.contextUpdatedAt!==null&&(candidate.contextUpdatedAt!<frontier.contextUpdatedAt||candidate.contextUpdatedAt===frontier.contextUpdatedAt&&scoreFacts(candidate,!!frontier.tennis)!==scoreFacts(frontier,!!frontier.tennis)))
      throw new Error('The tennis scoreboard is older than, or disagrees with, the last verified report.');
    const record:TennisScoreboardRecord={fetchedAt:checkedAt,successfulCheckAt:receipt.receivedAt,market:candidate,error:null};
    return await persist(record);
  }catch(error){
    requestSignal.throwIfAborted();
    await readLatest().catch(()=>{});requestSignal.throwIfAborted();
    const record:TennisScoreboardRecord={fetchedAt:deps.now(),successfulCheckAt:previous?.successfulCheckAt??null,market:publicSnapshot(newestMarket(market,previous?.market)),error:sourceError(error,'The tennis scoreboard is unavailable. Checking again shortly.')};
    try{return await persist(record);}catch{requestSignal.throwIfAborted();return result(record,false);}
  }
}
