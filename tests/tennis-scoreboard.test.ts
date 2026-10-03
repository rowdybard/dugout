import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTennisScoreboard,normalizeSelectedTennisScoreboard,type TennisScoreboardRecord,type TennisScoreboardDependencies} from '../lib/tennis/tennis-scoreboard.ts';
import {TENNIS_SCORE_NOW as NOW,tennisScoreEvent,tennisScoreMarket} from './helpers/tennis-scoreboard-fixture.ts';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';
import type {TennisMarket} from '../lib/tennis/types';

function harness(){
  let time=NOW,calls=0,event=tennisScoreEvent();const records=new Map<string,TennisScoreboardRecord>(),writes:string[]=[];
  const deps:TennisScoreboardDependencies={now:()=>time,read:async key=>records.get(key)??null,write:async(key,value)=>{records.set(key,value);writes.push(key);},fetchEvent:async(id,signal)=>{calls++;assert.equal(id,'136204');assert.ok(signal);return {data:{events:[event]},receipt:{receivedAt:time}};}};
  return {deps,records,writes,setTime:(value:number)=>{time=value;},setEvent:(value:ReturnType<typeof tennisScoreEvent>)=>{event=value;},calls:()=>calls};
}
test('selected compact scores retain explicit player IDs and server while leaving quotes and order rules untouched',async()=>{
  const market=tennisScoreMarket(),before=structuredClone(market),f=harness(),result=await loadTennisScoreboard(market,f.deps);
  assert.equal(result.error,null);assert.equal(result.successfulCheckAt,NOW);assert.equal(result.market.contextUpdatedAt,NOW-1000);assert.equal(result.market.observedAt,NOW);
  assert.deepEqual(result.market.tennisIdentity,{yesPlayerId:'101',noPlayerId:'202'});assert.equal(result.market.tennis?.serving,'NO');assert.deepEqual(result.market.tennis?.games,{yes:0,no:3});
  for(const key of ['bid','ask','price','execution','quoteObservedAt','quoteSource','quoteSourceTime'] as const)assert.deepEqual(result.market[key],market[key]);
  assert.deepEqual(result.market.history,[]);assert.deepEqual(market,before);assert.ok(f.writes.every(key=>key.startsWith('tennis:scoreboard:v1:')));
  const saved=[...f.records.values()][0];assert.equal(saved.market.bid,null);assert.equal(saved.market.quoteObservedAt,undefined,'public cache never stores a newly claimed quote receipt');
});
test('the five-second cache preserves the original actual check and source clocks',async()=>{
  const market=tennisScoreMarket(),f=harness(),first=await loadTennisScoreboard(market,f.deps);
  f.setTime(NOW+4999);const cached=await loadTennisScoreboard(market,f.deps);assert.equal(cached.cacheHit,true);assert.equal(cached.successfulCheckAt,first.successfulCheckAt);assert.equal(cached.market.observedAt,NOW);assert.equal(f.calls(),1);
  f.setTime(NOW+5000);f.setEvent(tennisScoreEvent(NOW+4000));const next=await loadTennisScoreboard(market,f.deps);assert.equal(next.cacheHit,false);assert.equal(f.calls(),2);assert.equal(next.successfulCheckAt,NOW+5000);
});
test('event, winner market, explicit players, tour and source clocks are independently verified',()=>{
  const market=tennisScoreMarket();
  const changes=[(event:ReturnType<typeof tennisScoreEvent>)=>{event.id='999';},(event:ReturnType<typeof tennisScoreEvent>)=>{event.slug='other';},(event:ReturnType<typeof tennisScoreEvent>)=>{event.eventState.type='football';},
    (event:ReturnType<typeof tennisScoreEvent>)=>{event.markets[0].slug='other';},(event:ReturnType<typeof tennisScoreEvent>)=>{event.markets[0].marketSides[0].teamId=202;},(event:ReturnType<typeof tennisScoreEvent>)=>{event.markets[0].marketSides[0].team.id=303;event.markets[0].marketSides[0].teamId=303;},
    (event:ReturnType<typeof tennisScoreEvent>)=>{event.markets[0].marketSides[0].team.league='atp';},(event:ReturnType<typeof tennisScoreEvent>)=>{event.markets[0].marketSides[0].description='Unknown';},(event:ReturnType<typeof tennisScoreEvent>)=>{event.eventState.updatedAt=new Date(NOW+1).toISOString();}];
  for(const change of changes){const event=tennisScoreEvent();change(event);assert.throws(()=>normalizeSelectedTennisScoreboard({events:[event]},market,NOW));}
  assert.throws(()=>normalizeSelectedTennisScoreboard({events:[tennisScoreEvent(),tennisScoreEvent()]},market,NOW));
});
test('same-time conflicts and backward reports retain the last consistent score, then recover only on newer facts',async()=>{
  const market=tennisScoreMarket(),f=harness();await loadTennisScoreboard(market,f.deps);
  f.setTime(NOW+5000);const conflict=tennisScoreEvent();conflict.score=conflict.eventState.score='4-6, 0-3:AD-40';f.setEvent(conflict);
  const blocked=await loadTennisScoreboard(market,f.deps);assert.ok(blocked.error);assert.equal(blocked.market.score,'4-6, 0-3:40-40');assert.equal(blocked.market.observedAt,NOW);assert.equal(blocked.successfulCheckAt,NOW);
  f.setTime(NOW+10_000);f.setEvent(tennisScoreEvent(NOW-2000));assert.ok((await loadTennisScoreboard(market,f.deps)).error);
  f.setTime(NOW+15_000);const newer=tennisScoreEvent(NOW+14_000);newer.score=newer.eventState.score='4-6, 0-3:AD-40';f.setEvent(newer);
  const recovered=await loadTennisScoreboard(market,f.deps);assert.equal(recovered.error,null);assert.equal(recovered.market.score,'4-6, 0-3:AD-40');
});
test('legacy catalog scores can establish explicit participant details without changing equal-time score facts',async()=>{
  const market=tennisScoreMarket(NOW,NOW-1000);delete market.tennis;delete market.tennisIdentity;const f=harness();
  const result=await loadTennisScoreboard(market,f.deps);assert.equal(result.error,null);assert.equal(result.market.tennisIdentity?.yesPlayerId,'101');
});
test('ended matches still report the final score through the existing verified selection',async()=>{
  const market=tennisScoreMarket(),f=harness(),final=tennisScoreEvent();final.ended=final.eventState.ended=true;final.live=final.eventState.live=false;final.score=final.eventState.score='4-6, 0-6';final.period=final.eventState.period='FT';f.setEvent(final);
  const result=await loadTennisScoreboard(market,f.deps);assert.equal(result.error,null);assert.equal(result.market.ended,true);assert.equal(result.market.active,false);assert.equal(result.market.score,'4-6, 0-6');
});
test('source failures and late cancelled results never refresh last-known clocks or persist a late check',async()=>{
  const market=tennisScoreMarket(),f=harness();await loadTennisScoreboard(market,f.deps);f.setTime(NOW+5000);f.deps.fetchEvent=async()=>{throw new Error('Provider backoff');};
  const failed=await loadTennisScoreboard(market,f.deps);assert.equal(failed.error,'Provider backoff');assert.equal(failed.market.observedAt,NOW);assert.equal(failed.successfulCheckAt,NOW);
  f.setTime(NOW+10_000);let resolve!:(value:Awaited<ReturnType<TennisScoreboardDependencies['fetchEvent']>>)=>void;f.deps.fetchEvent=()=>new Promise(yes=>{resolve=yes;});
  const controller=new AbortController(),pending=loadTennisScoreboard(market,f.deps,controller.signal);await new Promise(yes=>setImmediate(yes));const before=f.writes.length;controller.abort();await assert.rejects(pending,{name:'AbortError'});
  resolve({data:{events:[tennisScoreEvent(NOW+9000)]},receipt:{receivedAt:NOW+10_000}});await new Promise(yes=>setImmediate(yes));assert.equal(f.writes.length,before);
});
test('a newer supplied verified score outranks the public cache on both cache hits and older fresh responses',async()=>{
  const market=tennisScoreMarket(),f=harness();await loadTennisScoreboard(market,f.deps);
  const supplied=tennisScoreMarket(NOW+2000,NOW+1500);supplied.score='4-6, 0-3:AD-40';supplied.tennis!.points={yes:'AD',no:'40'};
  f.setTime(NOW+2000);const hit=await loadTennisScoreboard(supplied,f.deps);assert.equal(hit.cacheHit,true);assert.equal(hit.market.contextUpdatedAt,NOW+1500);assert.equal(hit.market.score,supplied.score);
  f.setTime(NOW+5000);f.setEvent(tennisScoreEvent(NOW+1000));const old=await loadTennisScoreboard(supplied,f.deps);assert.ok(old.error);assert.equal(old.market.contextUpdatedAt,NOW+1500);assert.equal(old.market.score,supplied.score);
});
test('a slow failure rereads and preserves the newer concurrent successful source and receipt',async()=>{
  const market=tennisScoreMarket(),f=harness();await loadTennisScoreboard(market,f.deps);f.setTime(NOW+5000);
  let reject!:(error:Error)=>void;f.deps.fetchEvent=()=>new Promise((_resolve,no)=>{reject=no;});
  const slow=loadTennisScoreboard(market,f.deps);await new Promise(resolve=>setImmediate(resolve));
  f.setTime(NOW+6000);f.deps.fetchEvent=async()=>({data:{events:[tennisScoreEvent(NOW+5500)]},receipt:{receivedAt:NOW+6000}});
  const newer=await loadTennisScoreboard(market,f.deps);assert.equal(newer.error,null);
  f.setTime(NOW+7000);reject(new Error('Late failure'));const failed=await slow;
  assert.equal(failed.market.contextUpdatedAt,NOW+5500);assert.equal(failed.market.observedAt,NOW+6000);assert.equal(failed.successfulCheckAt,NOW+6000);
  assert.equal([...f.records.values()][0].market.contextUpdatedAt,NOW+5500);
});
test('an atomic cache guard returns the concurrent winner when it arrives after the failure reread',async()=>{
  const market=tennisScoreMarket(),f=harness();await loadTennisScoreboard(market,f.deps);f.setTime(NOW+5000);f.deps.fetchEvent=async()=>{throw new Error('Failure');};
  f.deps.write=async(key,record)=>{
    const winner:TennisScoreboardRecord={fetchedAt:NOW+5000,successfulCheckAt:NOW+5000,market:normalizeSelectedTennisScoreboard({events:[tennisScoreEvent(NOW+4000)]},market,NOW+5000),error:null};
    f.records.set(key,winner);assert.ok(record.market.contextUpdatedAt!<winner.market.contextUpdatedAt!);return false;
  };
  const value=await loadTennisScoreboard(market,f.deps);assert.equal(value.error,null);assert.equal(value.market.contextUpdatedAt,NOW+4000);assert.equal(value.successfulCheckAt,NOW+5000);
});
test('tennis raw score, mapped set scores, phase flags and source clock come from one authoritative state snapshot',()=>{
  const market=tennisScoreMarket(),event=tennisScoreEvent();event.score='0-0';event.period='NS';event.live=false;event.ended=true;
  const normalized=normalizeSelectedTennisScoreboard({events:[event]},market,NOW),catalog=normalizeTennisEvent(event,'WTA',NOW)[0];
  for(const result of [normalized,catalog]){
    assert.equal(result.score,event.eventState.score);assert.equal(result.period,'S2');assert.equal(result.live,true);assert.equal(result.ended,false);assert.equal(result.contextUpdatedAt,NOW-1000);assert.deepEqual(result.tennis?.games,{yes:0,no:3});
  }
});
test('legacy quote fallback is frozen before a scoreboard receipt advances observedAt',async()=>{
  const market:TennisMarket=tennisScoreMarket(),f=harness();delete market.quoteObservedAt;
  const value=await loadTennisScoreboard(market,f.deps);assert.equal(value.market.observedAt,NOW);assert.equal(value.market.quoteObservedAt,market.observedAt);
});
