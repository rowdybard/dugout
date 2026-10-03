import test from 'node:test';
import assert from 'node:assert/strict';
import {accountValue,openBook,priceOf,priceNote} from '../lib/tennis/open-book.ts';
import {focusedEngine} from '../lib/tennis/decision-view.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisPosition,TennisSession} from '../lib/tennis/types';

const NOW=Date.parse('2026-10-03T20:00:00Z');
function position(over:Partial<TennisPosition>):TennisPosition{
  return {id:'p',slug:'g',league:'CFB',title:'A vs B',side:'YES',name:'A',quantity:10,initialQuantity:10,costBasis:5,entryCost:5,entryPrice:.5,entryFees:0,openedAt:NOW-60_000,
    status:'open',realizedPnl:0,exitFees:0,proceeds:0,netLiquidationValue:6,liquidationQuantity:10,markedAt:NOW-2000,exitPolicy:'maker',
    market:{slug:'g',yesName:'A',noName:'B'} as TennisPosition['market'],...over} as TennisPosition;
}
function account(...positions:TennisPosition[]):TennisSession{
  return {...createTennisSession(defaultLiveTennisConfig(100),NOW-3_600_000),cash:95,positions};
}

test('one valuation: current, old, partial and missing prices are named the same way everywhere',()=>{
  assert.equal(priceOf(position({}),NOW).state,'current');
  const old=priceOf(position({markedAt:NOW-40_000}),NOW);
  assert.equal(old.state,'old');assert.equal(priceNote(old,10),'price 40 s old');
  const part=priceOf(position({liquidationQuantity:6,netLiquidationValue:3.6}),NOW);
  assert.equal(part.state,'partial');assert.equal(priceNote(part,10),'only 6 of 10 shares priced');
  assert.equal(priceOf(position({netLiquidationValue:null,markedAt:null}),NOW).state,'missing');
  // The balance, the holdings list and "Sell everything" agree: an old price still counts, and is labelled.
  const session=account(position({markedAt:NOW-40_000}));
  const value=accountValue(session,NOW);
  assert.equal(value.value,101);assert.equal(value.complete,false);assert.equal(value.note,'1 price old');
  const [holding]=openBook(session,[],NOW).holdings;
  assert.equal(holding.value,6);assert.equal(holding.result,1);assert.equal(holding.priceNote,'price 40 s old');
  // A partly priced holding is compared with the cost of the priced shares only (not shown as a loss).
  const [partial]=openBook(account(position({liquidationQuantity:6,netLiquidationValue:3.6})),[],NOW).holdings;
  assert.equal(partial.result,0.6);
});

test('the engine card only shows the focused game: after switching games the old plan is hidden',()=>{
  const session={...account(),config:{...account().config,focusSlug:'new-game'},
    enginePlan:{time:NOW,slug:'old-game',phase:'live',pack:'p',trust:'t',summary:'Buy',considered:[]},
    whyNot:{time:NOW,slug:'old-game',strategy:'engine',code:'PHASE',detail:'old'}} as TennisSession;
  const view=focusedEngine(session);
  assert.equal(view.plan,undefined);assert.equal(view.why,null);assert.equal(view.otherGame,true);
  const same=focusedEngine({...session,config:{...session.config,focusSlug:'old-game'}});
  assert.equal(same.plan?.slug,'old-game');assert.equal(same.why?.detail,'old');
});

test('reports: resting-order trades are scored by mode, game and rules, and a verdict needs enough games',async()=>{
  const {sessionTradeRecords}=await import('../lib/tennis/research-tracking.ts');
  const {scoreRows}=await import('../lib/decision/scorecard.ts');
  const terms={rulesRevision:3,mode:'bold' as const,auto:true,orderSize:12,game:'octopus' as const};
  const closed=position({status:'closed',realizedPnl:.5,entryCost:5,openedUnder:terms});
  const records=sessionTradeRecords(account(closed,position({id:'q',status:'closed',realizedPnl:-.2,entryCost:5})));
  assert.deepEqual(records.map(r=>r.variant).sort(),['Bold (Auto) · Octopus · rules r3','before tracking']);
  assert.equal(records[0].strategy,'maker-quote');
  // 40 winning trades, all from one game: not enough games for a verdict.
  const one=Array.from({length:40},(_,i)=>({strategy:'s',version:'1',sample:'forward-paper' as const,game:'g',time:i,ret:.1}));
  const [row]=scoreRows(one,{minTrades:()=>30,minGames:()=>20});
  assert.equal(row.verdict,'insufficient');assert.match(row.reason,/40 of 30 trades, 1 of 20 games/);
});
