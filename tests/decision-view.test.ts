import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionView} from '../lib/tennis/decision-view.ts';
import {createTennisSession,defaultTennisConfig} from '../lib/tennis/engine.ts';
import type {TennisMarket,TennisPosition,TennisRuntime} from '../lib/tennis/types';

const now=100000;
const market=(slug='focus'):TennisMarket=>({slug,eventId:slug,eventSlug:slug,title:slug,league:'CFB',yesName:`${slug} A`,noName:`${slug} B`,
  startTime:new Date(0).toISOString(),live:true,ended:false,score:'0-0',period:'1',tournament:null,active:true,
  bid:.5,ask:.51,price:.505,observedAt:now,contextUpdatedAt:now,quoteObservedAt:now,quoteSource:'REST',history:[],execution:null});
const runtime=(lastSuccessfulCheck=now):TennisRuntime=>({mode:'service',intervalMs:2500,backgroundConnected:true,streamConfigured:true,description:'Synthetic runner',lastSuccessfulCheck});
const session=()=>{const value=createTennisSession({...defaultTennisConfig(),focusSlug:'focus'},now-10000);value.status='running';return value;};
const position=(slug='held'):TennisPosition=>({id:'held',slug,league:'CFB',title:slug,side:'NO',name:`${slug} B`,quantity:5,initialQuantity:5,costBasis:3,entryCost:3,entryPrice:.59,entryFees:.05,
  openedAt:now-5000,status:'open',realizedPnl:0,exitFees:0,proceeds:0,netLiquidationValue:null,liquidationQuantity:0,markedAt:null,market:market(slug)});

test('paused, idle and stopped sessions do not claim to be watching a live display feed',()=>{
  const value=session();
  for(const [status,state] of [['paused','Paused'],['idle','Ready'],['stopped','Stopped']] as const){
    value.status=status;
    const view=decisionView(value,market(),runtime(now-50000),now);
    assert.equal(view.state,state);
    assert.equal(view.checkStale,false);
    assert.equal(view.quoteAge,null);
    assert.equal(view.gameAge,null);
  }
});

test('a recent runner pass stays distinct from its old accepted book and game report',()=>{
  const value=session();
  value.lastReason='Rejected backward provider book timestamp.';
  value.quotes={focus:{time:now-60000,bid:.5,ask:.51,source:'REST'}};
  value.footballReports={focus:{assessment:{status:'stale',reason:'Old report',reportTime:now-70000,receiptTime:now-60000,reportAgeMs:70000,receiptAgeMs:60000}}};
  const view=decisionView(value,market(),runtime(now-500),now);
  assert.equal(view.state,'Watching');
  assert.equal(view.checkAge,500);
  assert.equal(view.quoteAge,60000);
  assert.equal(view.gameAge,70000);
  assert.equal(view.reason,value.lastReason);
});

test('unrelated chart metadata and clocks cannot impersonate the saved bot focus',()=>{
  const value=session();
  value.quotes={chart:{time:now,bid:.5,ask:.51,source:'REST'}};
  const view=decisionView(value,market('chart'),runtime(),now);
  assert.equal(view.focus,'focus');
  assert.equal(view.quoteAge,null);
  assert.equal(view.gameAge,null);
  assert.equal(view.identityKnown,false);
  assert.match(view.focusName,/focus.*not in the current game list/);
  assert.doesNotMatch(view.focusName,/chart/);
});

test('paused held position retains its identity and exit management, rather than a different entry focus',()=>{
  const value=session();value.status='paused';value.positions=[position()];
  value.quotes={held:{time:now-1000,bid:.5,ask:.51,source:'REST'},focus:{time:now,bid:.5,ask:.51,source:'REST'}};
  const view=decisionView(value,market('focus'),runtime(),now);
  assert.equal(view.state,'Holding · entries paused');
  assert.equal(view.focus,'held');
  assert.equal(view.focusName,'held A vs. held B');
  assert.equal(view.side,'NO');
  assert.equal(view.quoteAge,1000);
});

test('old setup signals and a fresh display quote do not imply a current forming setup',()=>{
  const value=session();value.quotes={focus:{time:now-6000,bid:.5,ask:.51,source:'REST'}};
  value.signals['focus:YES']={phase:'RECOVERING',confirmations:1,lastObservedAt:now-6000,reason:'Old setup'};
  assert.equal(decisionView(value,market(),runtime(),now).state,'Watching');
  value.quotes.focus.time=now-500;value.signals['focus:YES'].lastObservedAt=now-500;
  assert.equal(decisionView(value,market(),runtime(),now).state,'Setup forming');
  assert.equal(decisionView(value,market(),runtime(now-25000),now).state,'Setup forming','a slow runner cycle is not a stale bot');
  assert.equal(decisionView(value,market(),runtime(now-50000),now).state,'Bot is behind');
});

test('leading reason selects the corresponding side, not a newer other-outcome diagnostic',()=>{
  const value=session();value.lastReason='YES recovery is still forming.';
  value.decisions=[{id:'yes',time:now-1000,slug:'focus',side:'YES',action:'WAIT',code:'A',reason:value.lastReason},
    {id:'no',time:now-500,slug:'focus',side:'NO',action:'SKIP',code:'B',reason:'NO lacks headroom.'}];
  assert.equal(decisionView(value,market(),runtime(),now).side,'YES');
});

test('future or absent source times remain unknown rather than becoming a fresh age',()=>{
  const value=session();value.quotes={focus:{time:now+1,bid:.5,ask:.51,source:'REST'}};
  const view=decisionView(value,market(),runtime(now+1),now);
  assert.equal(view.quoteAge,null);
  assert.equal(view.checkAge,null);
  assert.equal(view.checkStale,true);
});

test('resting offers read in plain English with team names and prices',()=>{
  const value=session();
  value.maker={slug:'focus',quotes:{YES:{price:.7,quantity:7,placedAt:now,placedBookTime:now,activeAfter:now},NO:{price:.295,quantity:16,placedAt:now,placedBookTime:now,activeAfter:now}},
    pulledUntil:0,eventKey:null,lastBookTime:now,reason:'',fills:0,rebates:0};
  const view=decisionView(value,market(),runtime(now-1000),now);
  assert.equal(view.state,'Buy offers posted');
  assert.equal(view.reason,'Offering to buy focus A at 70¢ and focus B at 29.5¢. A trade happens only when someone sells at that price, so most checks change nothing.');
});
