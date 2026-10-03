import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultTennisBotConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
import {bindWalletProjection,walletCommitments,type WalletProjection} from '../lib/tennis/wallet-risk.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types.ts';

const NOW=Date.parse('2026-10-03T20:00:00Z'),SLUG='synthetic-adaptive-review';
const exact=(value:number)=>Math.round(value*1e6)/1e6;
function input(time:number,bid:number,ask:number,bidQuantity=1000):TennisInput{
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:bidQuantity}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug:SLUG,eventId:SLUG,eventSlug:SLUG,title:'Synthetic A vs B',league:'ATP',yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,
    score:'6-4, 2-2',period:'Set 2',tournament:'Synthetic',bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
    execution:{slug:SLUG,league:'ATP',active:true,minimumTradeQty:.01,quantityIncrement:.01,priceIncrement:.01,feeCoefficient:.0695}}};
}
function pendingAdd():TennisSession{
  let session=applyTennisAction(createTennisSession({...defaultTennisBotConfig(),focusSlug:SLUG},NOW-60000),{action:'start',commandId:'start'},[],NOW-60000);
  for(let i=0;i<12;i++){const time=NOW-60000+i*4000;session=stepTennisSession(session,[input(time,.47,.48)],time);}
  session=stepTennisSession(session,[input(NOW-12000,.49,.50)],NOW-12000);
  session=stepTennisSession(session,[input(NOW-7000,.49,.50)],NOW-7000);
  session=stepTennisSession(session,[input(NOW,.49,.50)],NOW);
  assert.equal(session.positions[0]?.exitPolicy,'tennis-trend');
  for(const [time,bid,ask] of [[NOW+2000,.45,.46],[NOW+4000,.46,.47],[NOW+6000,.46,.47]])session=stepTennisSession(session,[input(time,bid,ask)],time);
  assert.equal(session.pending?.tennisAdd,true);
  return session;
}

test('a saved quote-age setting cannot relax the five-second adaptive execution limit',()=>{
  const session=pendingAdd();session.config.maxBookAgeMs=30000;
  assert.match(validateTennisConfig(session.config)??'',/five seconds/);
  const next=stepTennisSession(session,[input(NOW+8000,.46,.47)],NOW+14000);
  assert.equal(next.cash,session.cash);
  assert.equal(next.ledger.length,1);
  assert.equal(next.positions[0].tennisAdd?.filledBuys??0,0);
});

test('fees from an addition cannot push shared commitments above half of the resulting executable equity',()=>{
  const session=pendingAdd(),before=walletCommitments(session,undefined,true);
  const risk:WalletProjection={botId:'tennis',otherPositions:[],otherPending:[],otherResting:Math.floor((before.cap-before.open-session.pending!.budget!)*1e6)/1e6,startingCash:100,lossFraction:.2,now:NOW+8000};
  bindWalletProjection(session,risk);
  assert.ok(walletCommitments(session).total<=walletCommitments(session).cap);
  const next=stepTennisSession(session,[input(NOW+8000,.46,.47)],NOW+8000,risk),after=walletCommitments(next);
  assert.ok(after.total<=after.cap+1e-7,`Commitments ${after.total} exceeded the post-fee cap ${after.cap}.`);
  assert.equal(next.cash,session.cash);
  assert.equal(next.ledger.length,1);
});

test('a persisted added position allocates weighted fees across partial exits without enlarging its original dollar stop',()=>{
  let session=stepTennisSession(pendingAdd(),[input(NOW+8000,.46,.47)],NOW+8000);
  const initial=structuredClone(session.positions[0]),half=Math.floor(initial.quantity/2*100)/100;
  assert.equal(initial.tennisAdd?.filledBuys,1);
  session=stepTennisSession(session,[input(NOW+10000,.40,.41)],NOW+10000);
  assert.equal(session.pending?.action,'SELL');
  session=stepTennisSession(JSON.parse(JSON.stringify(session)),[input(NOW+12000,.40,.41,half)],NOW+12000);
  const partial=session.positions[0];
  assert.equal(partial.status,'open');assert.equal(partial.quantity,exact(initial.quantity-half));
  assert.equal(partial.entryCost,initial.entryCost);assert.equal(partial.entryFees,initial.entryFees);
  assert.equal(partial.costBasis,exact(initial.costBasis-exact(initial.costBasis*half/initial.quantity)));
  assert.equal(partial.tennisTrend?.maxLossDollars,initial.tennisTrend?.maxLossDollars);
  const repeat=stepTennisSession(JSON.parse(JSON.stringify(session)),[input(NOW+12000,.40,.41,half)],NOW+12500);
  assert.equal(repeat.cash,session.cash);assert.equal(repeat.ledger.length,3);
  session=stepTennisSession(repeat,[input(NOW+14000,.40,.41)],NOW+14000);
  session=stepTennisSession(JSON.parse(JSON.stringify(session)),[input(NOW+16000,.40,.41)],NOW+16000);
  const closed=session.positions[0];
  assert.equal(closed.status,'closed');assert.equal(closed.quantity,0);assert.equal(closed.costBasis,0);
  assert.equal(closed.entryCost,initial.entryCost);assert.equal(closed.tennisAdd?.filledBuys,1);
  assert.equal(closed.realizedPnl,exact(closed.proceeds-closed.entryCost));
  assert.equal(closed.realizedPnl,exact(session.ledger.reduce((sum,row)=>sum+row.realizedPnl,0)));
  assert.equal(closed.tennisTrend?.maxLossDollars,initial.tennisTrend?.maxLossDollars);
});
