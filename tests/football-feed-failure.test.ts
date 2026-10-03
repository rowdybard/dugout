import test from 'node:test';
import assert from 'node:assert/strict';
import {createTennisSession,applyTennisAction,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import {loadPriorityContext,marketWithPriorityReport,type PriorityContextDependencies,type PriorityContextRecord} from '../lib/tennis/priority-context.ts';
import type {TennisInput,TennisMarket} from '../lib/tennis/types.ts';
import {FOOTBALL_FEED_NOW as NOW,montanaEvent,montanaMarket,espnSummary} from './helpers/football-feed-fixture.ts';

function book(market:TennisMarket,time:number,bid=.6,ask=.61):TennisInput {
  return {market,receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()}};
}

async function nativeQuotes(){
  let time=NOW,fail=false;
  const raw=montanaEvent(),event={...raw,eventState:{...raw.eventState,footballState:{driveState:{possessionTeamId:'1109',down:1,yfd:10,fieldPosition:{teamId:'1109',yard:25}}}}};
  const values=new Map<string,PriorityContextRecord>(),market=montanaMarket(NOW-1000,NOW-2000);
  const deps:PriorityContextDependencies={now:()=>time,read:async key=>values.get(key)??null,write:async(key,value)=>{values.set(key,value);},
    fetchEvent:async()=>{if(fail)throw new Error('Synthetic primary report unavailable');return {events:[event]};},
    fetchEspn:async()=>({data:espnSummary(),receipt:{receivedAt:time}})};
  const initial=await loadPriorityContext(market,deps),accepted=marketWithPriorityReport(market,initial);
  assert.equal(initial.assessment.status,'fresh');assert.equal(accepted.footballSources?.drive.provider,'POLYMARKET');
  let session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB'],focusSlug:market.slug,entries:'steady',autoMode:false},NOW-60000);
  session=applyTennisAction(session,{action:'start',commandId:'synthetic-native-start'},[],NOW-60000);
  session=stepTennisSession(session,[book(accepted,NOW)],NOW);
  assert.equal(session.maker?.quotes.YES?.price,.6);assert.equal(session.ledger.length,0);
  return {session,accepted,failedReport:async()=>{time=NOW+3000;fail=true;return loadPriorityContext(market,deps);}};
}

test('a failed primary check cancels native resting paper buys even when a fresh book crosses their price',async()=>{
  const f=await nativeQuotes(),failed=await f.failedReport();
  assert.equal(failed.assessment.status,'unknown');assert.equal(failed.reportMarket.football,null);
  assert.match(failed.reportMarket.footballSourceIssue??'',/primary report unavailable/);
  assert.equal(failed.market.football?.down,1,'Last reported native drive remains available for display');
  const executable=marketWithPriorityReport(f.accepted,failed);
  assert.equal(executable.football,null);assert.equal(executable.observedAt,NOW,'Failure never refreshes the primary receipt');
  const checked=stepTennisSession(f.session,[book(executable,NOW+3000,.59,.6)],NOW+3000);
  assert.equal(checked.footballReports?.[executable.slug].assessment.status,'unknown');
  assert.equal(checked.cash,100);assert.equal(checked.ledger.length,0);assert.equal(checked.positions.length,0);
  assert.deepEqual(checked.maker?.quotes,{});
});

test('a failed primary check still permits Sell everything on a fresh executable book',async()=>{
  const f=await nativeQuotes();
  let session=stepTennisSession(f.session,[book(f.accepted,NOW+1500,.59,.6)],NOW+1500);
  assert.equal(session.ledger.length,1);assert.equal(session.positions[0]?.status,'open');
  session=applyTennisAction(session,{action:'exit-now',commandId:'synthetic-sell-after-feed-failure'},[],NOW+2500);
  const failed=await f.failedReport(),executable=marketWithPriorityReport(f.accepted,failed);
  session=stepTennisSession(session,[book(executable,NOW+3000,.59,.6)],NOW+3000);
  assert.equal(session.footballReports?.[executable.slug].assessment.status,'unknown');
  assert.deepEqual(session.ledger.map(row=>row.action),['BUY','SELL']);assert.equal(session.positions[0].status,'closed');
  assert.equal(session.exitAll,undefined);assert.equal(session.status,'paused');assert.deepEqual(session.maker?.quotes,{});
  assert.equal(session.cash,Math.round((100+session.ledger.reduce((sum,row)=>sum+row.cashDelta,0))*1e6)/1e6);
});
