import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import {accountLimitsOn,PAPER_ACCOUNT_LIMITS,spendFraction} from '../lib/tennis/account-limits.ts';
import {lossLimitReached,remainingLossAllowance} from '../lib/tennis/loss-limit.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types';

// Paper accounts run without the account-wide limits (loss limit, daily trade count, 50% spending limit); the code
// keeps them for real money and the tests of the limits turn them on.
const START=Date.parse('2026-10-03T19:00:00Z'),SLUG='aec-cfb-home-away-2026-10-03',T0=START-60*60_000;
function input(time:number,bid:number,ask:number):TennisInput{
  return {receivedAt:time,source:'REST',sourceTime:time,
    book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:1000}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    market:{slug:SLUG,eventId:'4242',eventSlug:'cfb-home-away-2026-10-03',title:'Home vs Away',league:'CFB',yesName:'Home',noName:'Away',startTime:new Date(START).toISOString(),
      live:false,ended:false,active:true,score:null,period:null,clock:null,tournament:null,football:null,footballIdentity:{yesTeamId:'1',noTeamId:'2'},
      bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
      execution:{slug:SLUG,league:'CFB',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.005,feeCoefficient:.0695}}};
}
function started():TennisSession{
  const session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB'],focusSlug:SLUG,entries:'all'},START-7_200_000);
  session.id='synthetic-paper-limits';
  return applyTennisAction(session,{action:'start',commandId:'go'},[],START-7_200_000);
}

test('paper accounts have the account limits off; real money would have them on',()=>{
  assert.equal(PAPER_ACCOUNT_LIMITS,false);
  const paper=started();
  assert.equal(accountLimitsOn(paper),false);assert.equal(spendFraction(paper),1);
  assert.equal(accountLimitsOn({...paper,mode:'live' as 'paper'}),true,'any non-paper account keeps them');
  assert.equal(spendFraction({mode:'live'}),.5);
});

test('a paper run 30% down keeps trading: no loss stop, and the dip buy is not capped by a loss allowance',()=>{
  let session={...started(),cash:70};          // $30 already lost (the old limit was $20)
  assert.equal(lossLimitReached(session,70),false);
  assert.equal(remainingLossAllowance(session,70),Number.POSITIVE_INFINITY);
  session=stepTennisSession(session,[input(T0,.60,.61)],T0);
  assert.equal(session.status,'running',session.lastReason);
  assert.ok(session.maker?.quotes.YES||session.maker?.quotes.NO,session.maker?.reason??session.lastReason);
});
