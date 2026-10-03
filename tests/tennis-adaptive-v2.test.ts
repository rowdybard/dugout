import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultTennisBotConfig} from '../lib/tennis/rules.ts';
import {assessTennisTrend,createTennisTrend,type TennisTrendState} from '../lib/tennis/trend-exit.ts';
import {sessionTradeRecords} from '../lib/tennis/research-tracking.ts';
import {measureExitMarket} from '../lib/tennis/exit-analysis.ts';
import {bindWalletProjection} from '../lib/tennis/wallet-risk.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types.ts';

const NOW=Date.parse('2026-10-03T20:00:00Z'),SLUG='synthetic-adaptive-tennis';
function input(time:number,bid:number,ask:number,league:'ATP'|'WTA'='ATP'):TennisInput {
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug:SLUG,eventId:SLUG,eventSlug:SLUG,title:'Synthetic A vs B',league,yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,
    score:'6-4, 2-2',period:'Set 2',tournament:'Synthetic',bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
    execution:{slug:SLUG,league,active:true,minimumTradeQty:.01,quantityIncrement:.01,priceIncrement:.01,feeCoefficient:.0695}}};
}
function queued(ask=.40,league:'ATP'|'WTA'='ATP'):TennisSession {
  let session=applyTennisAction(createTennisSession({...defaultTennisBotConfig(),focusSlug:SLUG},NOW-60000),{action:'start',commandId:'start'},[],NOW-60000);
  for(let i=0;i<12;i++){const time=NOW-60000+i*4000;session=stepTennisSession(session,[input(time,ask-.03,ask-.02,league)],time);}
  const first=stepTennisSession(session,[input(NOW-12000,ask-.01,ask,league)],NOW-12000);
  assert.equal(first.pending,null);assert.equal(first.autoSignals![`${SLUG}:YES:momentum`].confirmations,1);
  const duplicate=stepTennisSession(first,[input(NOW-12000,ask-.01,ask,league)],NOW-11000);
  assert.equal(duplicate.pending,null);assert.equal(duplicate.autoSignals![`${SLUG}:YES:momentum`].confirmations,1);
  return stepTennisSession(duplicate,[input(NOW-7000,ask-.01,ask,league)],NOW-7000);
}
function held(ask=.40):TennisSession {
  const session=stepTennisSession(queued(ask),[input(NOW,ask-.01,ask)],NOW);
  assert.equal(session.positions[0]?.exitPolicy,'tennis-trend',session.lastReason);return session;
}
const rules={stopReturn:.25,executionDelayMs:1000,tickSize:.01,noiseMultiplier:2,minimumTrailTicks:2,reversalConfirmations:2,maxConfirmationGapMs:30000};
function assess(state:TennisTrendState,time:number,netExitValue:number,patch:Record<string,unknown>={}){
  return assessTennisTrend({state,now:time,maxBookAgeMs:5000,bookTime:time,quantity:20,costBasis:10,realizedPnl:0,netExitValue,liquidationQuantity:20,bid:.7,ask:.71,volatility:0,...patch});
}

for(const league of ['ATP','WTA'] as const)test(`${league} v2 enters the first independently confirmed 2c move at 40c with actual fees and a later fill`,()=>{
  const pending=queued(.40,league);
  assert.equal(pending.pending?.plan?.strategyVersion,'2');assert.equal(pending.pending?.plan?.exit,'tennis-trend');assert.equal(pending.pending?.plan?.code,'EXPLORE_PAPER');assert.equal(pending.pending?.plan?.evidence,null);
  assert.equal(pending.pending?.signalConfig?.momentumPoints,2);assert.equal(pending.cash,100);assert.equal(pending.ledger.length,0);
  const early=stepTennisSession(pending,[input(NOW-6500,.39,.40,league)],NOW-6500);assert.equal(early.ledger.length,0);
  const filled=stepTennisSession(JSON.parse(JSON.stringify(early)),[input(NOW,.39,.40,league)],NOW),position=filled.positions[0];
  assert.equal(filled.ledger.length,1,filled.lastReason);assert.equal(position?.plan?.strategyVersion,'2');assert.equal(position?.exitPolicy,'tennis-trend');
  assert.equal(position.tennisTrend?.initialCost,position.entryCost);assert.equal(position.tennisTrend?.maxLossDollars,Math.round(position.entryCost*.25*1e6)/1e6);
  assert.ok(position.entryFees>0);assert.equal(filled.shadows?.length??0,0);
});

test('v2 cancels a falling later book and does not buy without current exploration permission',()=>{
  for(const variant of ['fall','explore','stale'] as const){
    const session=queued(.74),book=input(NOW,.73,.74);
    if(variant==='fall'){book.book.bids[0].price=.62;book.book.asks[0].price=.63;}
    if(variant==='explore')session.config.explore=[];
    if(variant==='stale')book.receivedAt=NOW-6000;
    const next=stepTennisSession(session,[book],NOW);
    assert.equal(next.ledger.length,0);assert.equal(next.cash,100);if(variant!=='stale')assert.equal(next.pending,null);
  }
});

test('v2 rejects an actual all-in purchase whose full settlement payout cannot produce any net gain',()=>{
  const session=queued(.99),book=input(NOW,.98,.99);book.market.execution!.feeCoefficient=1;book.market.execution!.minimumTradeQty=1;book.market.execution!.quantityIncrement=1;
  const next=stepTennisSession(session,[book],NOW);
  assert.equal(next.pending,null);assert.equal(next.cash,100);assert.equal(next.ledger.length,0);
  assert.ok(next.decisions.some(row=>row.code==='COST_HEADROOM'&&/settlement payout/.test(row.reason)));
});

test('buying at56c then bidding59c is still a loss after fees and never arms a profit trail or a two-minute exit',()=>{
  let session=held(.56);
  session=stepTennisSession(session,[input(NOW+2000,.59,.60)],NOW+2000);
  assert.ok(session.positions[0].netLiquidationValue!<session.positions[0].costBasis);
  assert.equal(session.positions[0].tennisTrend?.protectedProfit,null);assert.equal(session.pending,null);assert.equal(session.ledger.length,1);
  session=stepTennisSession(session,[input(NOW+180000,.59,.60)],NOW+180000);
  assert.equal(session.positions[0].status,'open');assert.equal(session.pending,null);assert.equal(session.ledger.length,1);
});

test('profit floors ratchet after fees, allow ordinary15s confirmations, reject repeats and reset a gap beyond30s',()=>{
  const peak=assess(createTennisTrend(10,rules),1000,13.7);assert.equal(peak.state.protectedProfit,3.3);
  const first=assess(peak.state,16000,13);assert.equal(first.exit,false);assert.equal(first.state.reversalConfirmations,1);
  const repeated=assess(first.state,16000,13);assert.equal(repeated.exit,false);assert.equal(repeated.state.reversalConfirmations,1);
  const confirmed=assess(repeated.state,31000,13);assert.equal(confirmed.exit,true);assert.equal(confirmed.code,'TREND_REVERSAL');
  const gap=assess(first.state,47000,13);assert.equal(gap.exit,false);assert.equal(gap.state.reversalConfirmations,1);
  const widened=assess(peak.state,3000,13.5,{ask:.78,volatility:.05});assert.equal(widened.state.protectedProfit,3.3);
  const stale=assess(first.state,25000,13,{bookTime:16000});assert.equal(stale.exit,false);assert.equal(stale.state.lastBookTime,16000);
});

test('the original dollar stop wins even without volatility and incomplete books cannot manufacture profit',()=>{
  const initial=createTennisTrend(10,rules),stop=assess(initial,1000,7.5,{volatility:null});assert.equal(stop.exit,true);assert.equal(stop.code,'TREND_LOSS');
  const partial=assess(initial,1000,6,{liquidationQuantity:10});assert.equal(partial.exit,false);assert.equal(partial.state.protectedProfit,null);assert.equal(partial.state.peakNetPnl,null);
  const measurements=[0,20000,40000,60000].map(time=>({time,bid:.5,ask:.51,price:.505}));
  assert.equal(measureExitMarket(measurements,60000,60000).available,false);assert.equal(measureExitMarket(measurements,60000,60000,30000).available,true);
});

test('an actual profitable trend runs past two minutes and a confirmed reversal stages a later fee-aware exit',()=>{
  let session=held(.56);
  for(let i=1;i<=40;i++){const time=NOW+i*4000;session=stepTennisSession(session,[input(time,.70,.71)],time);}
  assert.equal(session.ledger.length,1);assert.equal(session.positions[0].status,'open');assert.ok(session.positions[0].tennisTrend!.protectedProfit!>0);
  session=stepTennisSession(session,[input(NOW+164000,.65,.66)],NOW+164000);assert.equal(session.pending,null);
  session=stepTennisSession(session,[input(NOW+180000,.65,.66)],NOW+180000);assert.equal(session.pending?.action,'SELL',session.lastReason);assert.equal(session.ledger.length,1);
  session=stepTennisSession(session,[input(NOW+182000,.65,.66)],NOW+182000);assert.equal(session.positions[0].status,'closed');assert.ok(session.positions[0].realizedPnl>0);
  assert.match(session.ledger.at(-1)?.reason??'',/protected profit floor/);
});

test('one lower-price confirmed additional buy merges actual costs, preserves the original stop, then exits with exact weighted accounting',()=>{
  let session=held(.50);const initial=structuredClone(session.positions[0]);
  for(const [time,bid,ask] of [[NOW+2000,.45,.46],[NOW+4000,.46,.47],[NOW+6000,.46,.47]])session=stepTennisSession(session,[input(time,bid,ask)],time);
  assert.equal(session.pending?.tennisAdd,true,session.lastReason);assert.equal(session.pending?.positionId,initial.id);assert.equal(session.ledger.length,1);
  const queuedCost=session.positions[0].costBasis,queuedQuantity=session.positions[0].quantity;
  const repeated=stepTennisSession(session,[input(NOW+6000,.46,.47)],NOW+6500);assert.equal(repeated.ledger.length,1);assert.equal(repeated.positions[0].costBasis,queuedCost);
  session=stepTennisSession(repeated,[input(NOW+8000,.46,.47)],NOW+8000);
  assert.equal(session.ledger.length,2,session.lastReason);assert.equal(session.positions.length,1);assert.equal(session.positions[0].tennisAdd?.filledBuys,1);
  assert.ok(session.positions[0].quantity>queuedQuantity);assert.ok(session.positions[0].entryPrice<initial.entryPrice);assert.equal(session.positions[0].tennisTrend?.maxLossDollars,initial.tennisTrend?.maxLossDollars);
  assert.equal(session.positions[0].entryCost,Math.round(-session.ledger.filter(r=>r.action==='BUY').reduce((sum,r)=>sum+r.cashDelta,0)*1e6)/1e6);
  session=stepTennisSession(session,[input(NOW+10000,.40,.41)],NOW+10000);assert.equal(session.pending?.action,'SELL');assert.equal(session.ledger.length,2);
  session=stepTennisSession(session,[input(NOW+12000,.40,.41)],NOW+12000);assert.equal(session.positions[0].status,'closed');assert.equal(session.ledger.length,3);
  assert.equal(sessionTradeRecords(session).length,1);assert.equal(sessionTradeRecords(session)[0].version,'2');
  assert.equal(session.positions[0].realizedPnl,Math.round((session.positions[0].proceeds-session.positions[0].entryCost)*1e6)/1e6);
});

test('an additional buy is canceled if its bounce weakens, and a hard exit takes priority over that pending buy',()=>{
  let session=held(.50);
  for(const [time,bid,ask] of [[NOW+2000,.45,.46],[NOW+4000,.46,.47],[NOW+6000,.46,.47]])session=stepTennisSession(session,[input(time,bid,ask)],time);
  assert.equal(session.pending?.tennisAdd,true);
  const weakened=stepTennisSession(session,[input(NOW+8000,.45,.46)],NOW+8000);assert.equal(weakened.ledger.length,1);assert.equal(weakened.pending,null);assert.equal(weakened.positions[0].tennisAdd?.filledBuys??0,0);
  const hard=stepTennisSession(session,[input(NOW+8000,.35,.36)],NOW+8000);assert.equal(hard.ledger.length,1);assert.equal(hard.pending?.action,'SELL');
  assert.ok(hard.decisions.some(row=>row.code==='ADD_CANCELLED'));
});

test('an additional buy cannot consume another bot’s cash reservation or exceed the shared commitment cap',()=>{
  let session=held(.50);
  for(const [time,bid,ask] of [[NOW+2000,.45,.46],[NOW+4000,.46,.47],[NOW+6000,.46,.47]])session=stepTennisSession(session,[input(time,bid,ask)],time);
  assert.equal(session.pending?.tennisAdd,true);
  bindWalletProjection(session,{botId:'tennis',otherPositions:[],otherPending:[],otherResting:40,startingCash:100,lossFraction:.2,now:NOW+8000});
  const blocked=stepTennisSession(session,[input(NOW+8000,.46,.47)],NOW+8000);
  assert.equal(blocked.pending,null);assert.equal(blocked.ledger.length,1);assert.equal(blocked.cash,session.cash);
  assert.ok(blocked.decisions.some(row=>row.code==='ADD_BUDGET'));
});

test('the first v2 purchase also respects the commitment cap after entry and liquidation fees',()=>{
  const session=queued(.40);bindWalletProjection(session,{botId:'tennis',otherPositions:[],otherPending:[],otherResting:40,startingCash:100,lossFraction:.2,now:NOW});
  const blocked=stepTennisSession(session,[input(NOW,.39,.40)],NOW);
  assert.equal(blocked.pending,null);assert.equal(blocked.cash,100);assert.equal(blocked.ledger.length,0);
  assert.ok(blocked.decisions.some(row=>row.code==='EXPOSURE'));
});

test('a continuing v2 trade settles only from an explicit final value and frozen exits survive a mode change',()=>{
  const session=held(.40),changed=applyTennisAction(session,{action:'update-rules',sessionId:session.id,expectedRulesRevision:0,commandId:'manual',rules:{tennisStrategy:'momentum',strategy:'momentum',tennisTradeStyle:'classic-v1',stopReturn:.08}},[],NOW+1);
  assert.deepEqual(changed.positions[0].tennisTrend,session.positions[0].tennisTrend);
  const final=input(NOW+2000,.45,.46);final.settlement=1;final.settlementReceivedAt=NOW+2000;final.market.ended=true;final.market.live=false;final.market.active=false;
  const settled=stepTennisSession(changed,[final],NOW+2000);assert.equal(settled.positions[0].status,'settled');assert.equal(settled.ledger.at(-1)?.action,'SETTLE');
});
