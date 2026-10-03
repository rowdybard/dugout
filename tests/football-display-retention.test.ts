import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPriorityContext,marketWithPriorityReport,type PriorityContextDependencies,type PriorityContextRecord} from '../lib/tennis/priority-context.ts';
import {assessFootballContext} from '../lib/tennis/football-context.ts';
import {footballFieldView} from '../lib/tennis/football-field.ts';
import {FOOTBALL_FEED_NOW as NOW,montanaMarket,montanaEvent,espnSummary} from './helpers/football-feed-fixture.ts';

function fixture(){
  let now=NOW,event=montanaEvent(),summary=espnSummary(NOW-100_000);
  const values=new Map<string,PriorityContextRecord>();
  const deps:PriorityContextDependencies={now:()=>now,read:async key=>values.get(key)??null,write:async(key,value)=>{values.set(key,value);},
    fetchEvent:async()=>({events:[event]}),fetchEspn:async()=>({data:summary,receipt:{receivedAt:now}})};
  return {deps,market:montanaMarket(NOW-1000,NOW-2000),setTime:(value:number)=>{now=value;},setEvent:(value:typeof event)=>{event=value;},setSummary:(value:typeof summary)=>{summary=value;}};
}

test('the first delayed ESPN drive is visible but never becomes executable entry context',async()=>{
  const f=fixture(),result=await loadPriorityContext(f.market,f.deps);
  assert.equal(result.error,null,'A successful provider response is not a failed request');
  assert.equal(result.successfulCheckAt,NOW);assert.notEqual(result.assessment.status,'fresh');
  assert.equal(result.market.football?.possessionTeam,'Idaho');assert.equal(result.market.football?.down,4);
  assert.equal(result.market.footballSources?.drive.reportTime,NOW-100_000);
  assert.equal(footballFieldView(result.market,NOW,result.assessment).lineOfScrimmage,27);
  assert.equal(result.reportMarket.football,null);
  const input=marketWithPriorityReport(f.market,result);
  assert.equal(input.football,null);assert.notEqual(assessFootballContext(input,NOW).assessment.status,'fresh');
  assert.notEqual(assessFootballContext(result.market,NOW).assessment.status,'fresh','Even accidentally assessing the display retains its explicit wait reason');
  f.setTime(NOW+2000);const cached=await loadPriorityContext(f.market,f.deps);
  assert.equal(cached.cacheHit,true);assert.equal(cached.reportMarket.football,null);assert.equal(cached.market.footballSources?.drive.reportTime,NOW-100_000);
});

test('delayed display drives advance independently but never roll back to an older ESPN play',async()=>{
  const f=fixture();await loadPriorityContext(f.market,f.deps);
  f.setTime(NOW+10_000);f.setEvent(montanaEvent(NOW+9000));
  const next=espnSummary(NOW-90_000);next.drives.current.plays[0].id='401868094162';next.drives.current.plays[0].sequenceNumber='39';next.drives.current.plays[0].end.down=1;f.setSummary(next);
  const advanced=await loadPriorityContext(f.market,f.deps);
  assert.equal(advanced.market.football?.down,1);assert.equal(advanced.reportMarket.football,null);
  f.setTime(NOW+20_000);f.setEvent(montanaEvent(NOW+19_000));f.setSummary(espnSummary(NOW-110_000));
  const old=await loadPriorityContext(f.market,f.deps);
  assert.equal(old.market.football?.down,1);assert.equal(old.market.footballSources?.drive.reportTime,NOW-90_000);
  assert.equal(old.reportMarket.football,null);assert.notEqual(old.assessment.status,'fresh');
});

test('a first report with mismatched scoreboard facts cannot invent a last-known drive',async()=>{
  const f=fixture(),event=montanaEvent();event.score='10-14';event.eventState.score='10-14';f.setEvent(event);
  const result=await loadPriorityContext(f.market,f.deps);
  assert.equal(result.market.football,null);assert.equal(result.reportMarket.football,null);assert.equal(result.error,null);
  assert.match(result.assessment.reason,/score and quarter/);
});

test('a usable Polymarket drive does not report an unused ESPN backup failure',async()=>{
  const f=fixture(),event=montanaEvent();
  Object.assign(event.eventState.footballState,{driveState:{possessionTeamId:'1109',down:2,yfd:8,fieldPosition:{teamId:'1109',yard:30}}});
  f.setEvent(event);f.deps.fetchEspn=async()=>{throw new Error('ESPN timed out');};
  const result=await loadPriorityContext(f.market,f.deps);
  assert.equal(result.assessment.status,'fresh');assert.equal(result.market.footballSources?.drive.provider,'POLYMARKET');assert.equal(result.error,null);
});
