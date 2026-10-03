import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultTennisBotConfig} from '../lib/tennis/rules.ts';
import type {TennisInput} from '../lib/tennis/types.ts';

const NOW=Date.parse('2026-10-03T20:00:00Z'),SLUG='synthetic-tennis-entry-recheck';
function input(time:number,bid:number,ask:number):TennisInput {
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug:SLUG,eventId:SLUG,eventSlug:SLUG,title:'Synthetic A vs B',league:'WTA',yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,
    score:'6-4, 2-2',period:'Set 2',tournament:'Synthetic',bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
    execution:{slug:SLUG,league:'WTA',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}}};
}

for(const selection of ['auto','momentum'] as const)test(`${selection} cancels a planned 74c buy when a later fresh quote falls to 63c`,()=>{
  let session=applyTennisAction(createTennisSession({...defaultTennisBotConfig(100,selection),entryBudget:5,focusSlug:SLUG},NOW-60000),{action:'start',commandId:'start'},[],NOW-60000);
  for(let i=0;i<12;i++){const time=NOW-60000+i*4000;session=stepTennisSession(session,[input(time,.70,.71)],time);}
  for(const time of [NOW-12000,NOW-7000])session=stepTennisSession(session,[input(time,.73,.74)],time);
  assert.equal(session.pending?.limitPrice,.74,session.lastReason);assert.equal(session.pending?.plan?.strategy,'tennis-momentum');
  assert.equal(session.pending?.signalConfig?.momentumPoints,3);assert.equal(session.pending?.signalSnapshot?.confirmations,2);
  const before=structuredClone(session),canceled=stepTennisSession(session,[input(NOW-5000,.62,.63)],NOW-5000);
  assert.equal(canceled.pending,null);assert.equal(canceled.cash,100);assert.equal(canceled.ledger.length,0);assert.equal(canceled.positions.length,0);
  assert.ok(canceled.decisions.some(row=>row.code==='SIGNAL_CHANGED'&&/weakened/.test(row.reason)));
  if(selection==='auto')assert.equal(canceled.autoSignals![`${SLUG}:YES:momentum`].phase,'COOLDOWN');
  assert.deepEqual(session,before);
});
