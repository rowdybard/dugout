import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import {committed} from '../lib/tennis/engine-plan.ts';
import type {TennisInput,TennisPosition,TennisSession} from '../lib/tennis/types';
import {setPaperAccountLimits} from '../lib/tennis/account-limits.ts';
// These tests check the account limits themselves, which are off for paper accounts by default (lib/tennis/account-limits.ts).
setPaperAccountLimits(true);

// Trading safeguards (docs/BOT-MANUAL.md, October 3 2026 review): the combined spending limit, no fills on closed or
// stale markets, and Bold's dip buy (loss limit, only a filled buy counts).

const START=Date.parse('2026-10-03T19:00:00Z'),SLUG='aec-cfb-home-away-2026-10-03';
type Over={state?:string;observedAt?:number;askQty?:number;active?:boolean;slug?:string};
function input(time:number,bid:number,ask:number,over:Over={}):TennisInput{
  const slug=over.slug??SLUG;
  return {receivedAt:time,source:'REST',sourceTime:time,
    book:{bids:[{price:bid,quantity:1000}],asks:[{price:ask,quantity:over.askQty??1000}],state:over.state??'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    market:{slug,eventId:String(slug.length*7919),eventSlug:slug.replace(/^aec-/,''),title:'Home vs Away',league:'CFB',yesName:'Home',noName:'Away',startTime:new Date(START).toISOString(),
      live:false,ended:false,active:over.active??true,score:null,period:null,clock:null,tournament:null,football:null,footballIdentity:{yesTeamId:'1',noTeamId:'2'},
      bid,ask,price:(bid+ask)/2,observedAt:over.observedAt??time,contextUpdatedAt:time,history:[],
      execution:{slug,league:'CFB',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.005,feeCoefficient:.0695}}};
}
function started(entries:'steady'|'all'='all',lossFraction?:number):TennisSession{
  const session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB'],focusSlug:SLUG,entries,...(lossFraction?{maxSessionLossFraction:lossFraction}:{})},START-7_200_000);
  session.id='synthetic-safeguards';
  return applyTennisAction(session,{action:'start',commandId:'go'},[],START-7_200_000);
}
const step=(session:TennisSession,time:number,bid:number,ask:number,over:Over={})=>stepTennisSession(session,[input(time,bid,ask,over)],time);
const T0=START-60*60_000;
const buys=(session:TennisSession)=>session.ledger.filter(e=>e.action==='BUY');
const yes=(session:TennisSession)=>session.positions.find(p=>p.exitPolicy==='maker'&&p.side==='YES'&&p.slug===SLUG)!;

test('spending limit: held shares elsewhere count, so new offers only use what is left of 50% of the balance',()=>{
  let session=step(started(),T0,.60,.61);
  const offers=()=>(['YES','NO'] as const).reduce((sum,side)=>sum+(session.maker?.quotes[side]?session.maker.quotes[side]!.price*session.maker.quotes[side]!.quantity:0),0);
  assert.ok(offers()>5,`Bold offers rest normally (${offers()})`);
  // $47 of shares held on another game (still worth $47): only $3 of the $50 limit is left.
  const other:TennisPosition={...structuredClone(session.positions[0]??{}) as TennisPosition,id:'other:maker:YES',slug:'aec-cfb-other-game-2026-10-03',side:'YES',name:'Other',
    quantity:94,initialQuantity:94,costBasis:47,entryCost:47,entryPrice:.5,entryFees:0,openedAt:T0,status:'open',realizedPnl:0,exitFees:0,proceeds:0,
    netLiquidationValue:47,liquidationQuantity:94,markedAt:T0,market:input(T0,.5,.51).market,exitPolicy:'maker',league:'CFB',title:'Other'};
  session={...session,cash:53,positions:[other]};
  session=step(session,T0+2000,.60,.61);
  assert.ok(offers()<=3+1e-9,`offers ${offers()} fit the $3 left`);
  assert.ok(committed(session)<=50+1e-9);
});

test('spending limit across the main game and six Octopus arms: held shares plus every resting offer stay within 50%',()=>{
  const arms=[1,2,3,4,5,6].map(n=>`aec-cfb-arm${n}-team${n}-2026-10-03`);
  let session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB'],focusSlug:SLUG,entries:'all',chaosSlugs:arms},START-7_200_000);
  session.id='synthetic-limit';
  session=applyTennisAction(session,{action:'start',commandId:'go'},[],START-7_200_000);
  const books=(t:number)=>[input(t,.60,.61),...arms.map(slug=>input(t,.50,.51,{slug}))];
  session=stepTennisSession(session,books(T0),T0);
  const quoted=Object.values(session.chaos??{}).filter(state=>state.quotes.YES||state.quotes.NO).length;
  assert.ok(quoted>=3,`several arms quote (${quoted})`);
  assert.ok(committed(session)<=50+1e-9,`committed $${committed(session)} within $50`);
  // Every resting offer fills at once: the shares held still fit the limit.
  const t=T0+5000;
  session=stepTennisSession(session,[input(t,.40,.41),...arms.map(slug=>input(t,.40,.41,{slug}))],t);
  const held=session.positions.filter(p=>p.status==='open').reduce((sum,p)=>sum+p.costBasis,0);
  assert.ok(held>0,'offers filled');
  assert.ok(held<=50+1e-6,`held $${held} within $50`);
});

test('resting offers never fill on a suspended market or on an out-of-date market status',()=>{
  const session=step(started(),T0,.60,.61);
  assert.ok(session.maker?.quotes.YES);
  let after=step(session,T0+5000,.59,.60,{state:'MARKET_STATE_SUSPENDED'});
  assert.equal(buys(after).length,0,'suspended: no fill');
  after=step(session,T0+5000,.59,.60,{observedAt:T0-6*60_000});
  assert.equal(buys(after).length,0,'status six minutes old: no fill');
  after=step(session,T0+5000,.59,.60,{active:false});
  assert.equal(buys(after).length,0,'inactive: no fill');
  after=step(session,T0+5000,.59,.60);
  assert.equal(buys(after).length,1,'open and current: fills');
});

test('exits still run when the market status is out of date (Bold take-profit)',()=>{
  let session=step(started(),T0,.60,.61);
  session=step(session,T0+5000,.59,.60);
  assert.equal(yes(session).status,'open');
  session=step(session,T0+6000,.66,.67,{observedAt:T0-6*60_000});
  const sale=session.ledger.find(e=>e.action==='SELL');
  assert.ok(sale,'sold at the take-profit');assert.match(sale.reason,/take-profit/i);
});

test('an unfilled dip buy is not a completed one: the 10-cent loss limit stays off',()=>{
  let session=step(started(),T0,.60,.61);
  session=step(session,T0+5000,.59,.60);                         // YES fills at 60¢
  session=step(session,T0+120_000,.54,.55,{askQty:.5});           // a dip, but too few shares offered to fill
  assert.equal(yes(session).dipBuys??0,0);
  assert.ok(session.decisions.some(d=>d.code==='DIP_BUY_UNFILLED'));
  session=step(session,T0+150_000,.45,.46,{askQty:.5});            // 15¢ under: no loss-limit sale
  assert.equal(session.ledger.filter(e=>e.action==='SELL').length,0);
  assert.equal(yes(session).status,'open');
});

test('dip buy: limited by the run loss allowance, and the holding is re-valued after it',()=>{
  let session=step(started('all',.05),T0,.60,.61);               // $5 loss limit on $100
  session=step(session,T0+5000,.59,.60);
  session=step(session,T0+120_000,.54,.55);
  const dip=session.ledger.find(e=>e.id.includes(':dip:'));
  assert.ok(dip,'dip buy within the allowance');
  assert.ok(-dip.cashDelta<=5+1e-9,`spent ${-dip.cashDelta}, within the $5 allowance`);
  const p=yes(session);
  assert.equal(p.liquidationQuantity,p.quantity,'value covers every share after the buy');
  assert.equal(p.markedAt,T0+120_000);
  // At the loss limit already: no dip buy at all.
  let full=step(started('all',.006),T0,.60,.61);
  full=step(full,T0+5000,.59,.60);
  full=step(full,T0+120_000,.54,.55);
  assert.equal(full.ledger.filter(e=>e.id.includes(':dip:')).length,0);
  assert.ok(full.decisions.some(d=>d.code==='DIP_BUY_LOSS_LIMIT'));
});

test('a rule change is saved with before/after values, the modes, and what it means for held shares',()=>{
  let session=step(started('all'),T0,.60,.61);
  session=step(session,T0+5000,.59,.60);                         // YES fills: shares are held
  session=applyTennisAction(session,{action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:'to-steady',
    rules:{entries:'steady',entryBudget:3}},[],T0+6000);
  const change=session.ruleChanges?.at(-1);
  assert.ok(change);
  assert.deepEqual(change.changes.entries,['all','steady']);
  assert.deepEqual(change.changes.entryBudget,[5,3]);
  assert.equal(change.modeBefore,'Bold');assert.equal(change.modeAfter,'Steady');
  assert.match(change.holdings,/held now follow Steady/);
  const row=session.decisions.findLast(d=>d.code==='RULES_UPDATED');
  assert.match(row!.reason,/entryBudget 5 → 3; entries all → steady/);
  assert.deepEqual(row!.ruleChange,change);
});

test('each purchase saves the rules it was made under (resting fill and Bold dip buy)',()=>{
  let session=step(started('all'),T0,.60,.61);
  session=step(session,T0+5000,.59,.60);
  const fill=session.ledger.find(e=>e.action==='BUY')!;
  assert.deepEqual(fill.terms,{rulesRevision:session.rulesRevision??0,mode:'bold',auto:false,orderSize:5,game:'main'});
  assert.deepEqual(yes(session).openedUnder,fill.terms);
  session=step(session,T0+120_000,.54,.55);
  const dip=session.ledger.find(e=>e.id.includes(':dip:'))!;
  assert.equal(dip.terms?.mode,'bold');
});

test('before kickoff a status up to 5 minutes old keeps offers up and fillable; near kickoff it needs 45 s',()=>{
  let session=step(started(),T0,.60,.61,{observedAt:T0-3*60_000});   // kickoff an hour away
  assert.ok(session.maker?.quotes.YES,session.maker?.reason??session.lastReason);
  session=step(session,T0+5000,.59,.60,{observedAt:T0-3*60_000});
  assert.equal(buys(session).length,1,'fills on a 3-minute-old pregame status');
  const near=START-2*60_000;                                          // two minutes before kickoff
  const close=step(started(),near,.60,.61,{observedAt:near-60_000});
  assert.ok(!close.maker?.quotes.YES,'a 1-minute-old status is too old this close to kickoff');
});
