import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine,defaultEngine} from '../lib/decision/engine.ts';
import {BUNDLED_PACK} from '../lib/decision/pack.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {tennisSignalContext} from '../lib/tennis/engine-plan.ts';
import {defaultTennisBotConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
import {sessionTradeRecords} from '../lib/tennis/research-tracking.ts';
import type {TennisConfig,TennisInput,TennisSession} from '../lib/tennis/types.ts';

const NOW=Date.parse('2026-10-03T20:00:00Z'),SLUG='synthetic-tennis-experiment';
function input(time:number,bid:number,ask:number,league:'ATP'|'WTA'='ATP'):TennisInput {
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{
    slug:SLUG,eventId:'synthetic-match',eventSlug:'synthetic-match',title:'Synthetic A vs B',league,yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,
    score:'6-4, 2-2',period:'Set 2',tournament:'Synthetic',bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:time,history:[],
    execution:{slug:SLUG,league,active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}}};
}
function queued(pattern:'recovery'|'momentum',selection:'auto'|'recovery'|'momentum'='auto',league:'ATP'|'WTA'='ATP',patch:Partial<TennisConfig>={}):TennisSession {
  const config={...defaultTennisBotConfig(100,selection),focusSlug:SLUG,...patch};
  let session=applyTennisAction(createTennisSession(config,NOW-60000),{action:'start',commandId:'start'},[],NOW-60000);
  for(let i=0;i<12;i++){const t=NOW-60000+i*4000;session=stepTennisSession(session,[input(t,pattern==='recovery'?.71:.59,pattern==='recovery'?.72:.60,league)],t);}
  const path=pattern==='recovery'?[[.61,.62],[.63,.64],[.64,.65]]:[[.61,.62],[.64,.65],[.64,.65]];
  for(const [i,[bid,ask]] of path.entries()){const t=NOW-12000+i*5000;session=stepTennisSession(session,[input(t,bid,ask,league)],t);}
  return session;
}

test('dedicated Tennis defaults are Auto paper experiments, with both tours and no football modes',()=>{
  const config=defaultTennisBotConfig();assert.equal(validateTennisConfig(config),null);
  assert.deepEqual(config.leagues,['ATP','WTA']);assert.equal(config.tennisStrategy,'auto');assert.equal(config.strategy,'auto');
  assert.deepEqual(config.explore,['tennis-recovery','tennis-momentum']);assert.equal(config.evidenceGate,'evidence-v1');
  assert.equal(config.maker,undefined);assert.equal(config.decisionEngine,undefined);assert.equal(config.autoMode,undefined);
  assert.match(validateTennisConfig({...config,evidenceGate:undefined})??'',/evidence gate/);
  assert.match(validateTennisConfig({...config,leagues:['CFB']})??'',/ATP and WTA/);
  assert.match(validateTennisConfig({...config,strategy:'recovery'})??'',/must match/);
  assert.match(validateTennisConfig({...config,maker:'paper-v1'})??'',/one position/);
});

for(const pattern of ['recovery','momentum'] as const)for(const league of ['ATP','WTA'] as const)for(const selection of ['auto',pattern] as const)
test(`${selection} selects registered ${pattern} on ${league}, then fills only on a later authoritative book`,()=>{
  const session=queued(pattern,selection,league),original=structuredClone(session);
  assert.equal(session.pending?.action,'BUY',session.lastReason);assert.equal(session.pending?.plan?.strategy,`tennis-${pattern}`);
  assert.equal(session.pending?.plan?.code,'EXPLORE_PAPER');assert.equal(session.pending?.plan?.evidence,null);assert.equal(session.pending?.plan?.exit,'scalp');
  assert.equal(session.pending?.signalConfig?.strategy,pattern);assert.equal(session.cash,100);assert.equal(session.ledger.length,0);
  assert.equal(session.config.tennisStrategy,selection);assert.equal(session.config.strategy,selection);assert.equal(session.enginePlan?.considered[0]?.strategy,`tennis-${pattern}`);
  const repeated=stepTennisSession(session,[input(NOW-2000,.64,.65,league)],NOW-1000);assert.equal(repeated.ledger.length,0);
  const filled=stepTennisSession(JSON.parse(JSON.stringify(session)),[input(NOW,.64,.65,league)],NOW);
  assert.equal(filled.ledger.length,1,filled.lastReason);assert.equal(filled.positions[0]?.strategy,pattern);assert.equal(filled.positions[0]?.exitPolicy,'scalp');
  assert.equal(filled.positions[0]?.plan?.code,'EXPLORE_PAPER');assert.ok(filled.positions[0]?.entryFees>0);assert.ok(filled.cash<100);
  assert.deepEqual(session,original);assert.equal(filled.maker,undefined);assert.equal(filled.chaos,undefined);
  assert.equal(stepTennisSession(filled,[input(NOW,.64,.65,league)],NOW+1).ledger.length,1);
});

test('a registered Tennis signal cannot bypass the evidence gate, risk checks or paper-only exploration',()=>{
  const ready=queued('momentum'),intent=ready.pending!,ctx=tennisSignalContext(ready,input(NOW-2000,.64,.65),NOW-2000,intent.side,intent.signalSnapshot!,intent.signalConfig!);
  const options={mode:'paper' as const,strategies:['tennis-momentum']};
  assert.equal(defaultEngine.plan(ctx,options).considered[0]?.blocked,'NO_EVIDENCE');
  assert.equal(defaultEngine.plan(ctx,{...options,explore:['tennis-momentum']}).actions[0]?.verdict.code,'EXPLORE_PAPER');
  for(const mode of ['pilot','real'] as const)assert.equal(defaultEngine.plan(ctx,{...options,mode,explore:['tennis-momentum']}).actions.length,0);
  assert.equal(defaultEngine.plan(ctx,{...options,explore:['tennis-momentum'],risk:{dayPnl:-100,sessionPnl:0,openExposure:0,tradesToday:0}}).considered[0]?.blocked,'DAILY_LOSS');
  const own={id:'test-tennis-momentum-dropped',title:'Test measured loser',status:'dropped' as const,sports:['ATP' as const],phases:['live' as const],styles:['taker-scalp' as const],strategies:['tennis-momentum@1'],
    estimate:{mean:-.05,lo:-.1,hi:0,unit:'return' as const},sample:'synthetic test',source:'synthetic test',plain:'Synthetic test fixture.'};
  const engine=createEngine({pack:{...BUNDLED_PACK,version:'synthetic-tennis-evidence',evidence:[...BUNDLED_PACK.evidence,own]},trust:'bundled'});
  assert.equal(engine.plan(ctx,{...options,explore:['tennis-momentum']}).considered[0]?.blocked,'DROPPED');
  const disabled=queued('momentum','auto','ATP',{explore:[]});assert.equal(disabled.pending,null);assert.equal(disabled.cash,100);assert.equal(disabled.ledger.length,0);
  assert.ok(disabled.decisions.some(row=>row.code==='NO_EVIDENCE'));
});

test('later-book entry rechecks the frozen signal, fresh executable depth and current evidence permission',()=>{
  for(const variant of ['buyers','spread','depth','explore','pack'] as const){
    const session=queued('momentum'),book=input(NOW,.64,.65);
    if(variant==='buyers'){book.book.bids[0].price=.63;book.book.asks[0].price=.64;}
    if(variant==='spread')book.book.bids[0].price=.60;
    if(variant==='depth')book.book.asks[0].quantity=1;
    if(variant==='explore')session.config.explore=[];
    if(variant==='pack')session.config.evidencePack='synthetic-pack-not-loaded';
    const blocked=stepTennisSession(session,[book],NOW);assert.equal(blocked.pending,null,variant);assert.equal(blocked.cash,100,variant);assert.equal(blocked.ledger.length,0,variant);
  }
});

test('Tennis trades retain the selected experiment and fee-aware exits through rule changes and scorecard recording',()=>{
  const filled=stepTennisSession(queued('momentum'),[input(NOW,.64,.65)],NOW),position=filled.positions[0];
  assert.equal(position.exitRules?.targetReturn,.03);assert.equal(position.exitRules?.stopReturn,.08);assert.equal(position.exitRules?.maxHoldMs,120000);
  const changed=applyTennisAction(filled,{action:'update-rules',sessionId:filled.id,expectedRulesRevision:0,commandId:'change',rules:{tennisStrategy:'recovery',strategy:'recovery',targetReturn:.5,stopReturn:.4,maxHoldMs:3600000}},[],NOW+1);
  assert.deepEqual(changed.positions[0].exitRules,position.exitRules);
  const staged=stepTennisSession(changed,[input(NOW+2000,.72,.73)],NOW+2000);assert.equal(staged.pending?.action,'SELL');assert.match(staged.pending?.reason??'',/Net profit target/);
  const closed=stepTennisSession(staged,[input(NOW+4000,.72,.73)],NOW+4000);
  assert.equal(closed.positions[0].status,'closed');assert.ok(closed.positions[0].realizedPnl>0);assert.ok(closed.positions[0].exitFees>0);
  assert.equal(closed.ledger.at(-1)?.strategy,'momentum');assert.equal(sessionTradeRecords(closed)[0]?.strategy,'tennis-momentum');
  assert.equal(sessionTradeRecords(closed)[0]?.version,'1');assert.equal(sessionTradeRecords(closed)[0]?.sample,'forward-paper');
});

for(const boundary of ['loss','time'] as const)test(`Tennis scalp ${boundary} exits remain delayed and executable`,()=>{
  const held=stepTennisSession(queued('recovery'),[input(NOW,.64,.65)],NOW),time=boundary==='loss'?NOW+2000:NOW+120001;
  const bid=boundary==='loss'?.5:.64,staged=stepTennisSession(held,[input(time,bid,bid+.01)],time);
  assert.equal(staged.pending?.action,'SELL');assert.match(staged.pending?.reason??'',boundary==='loss'?/Net loss threshold/:/Maximum holding time/);
  assert.equal(staged.ledger.length,1);const closed=stepTennisSession(staged,[input(time+2000,bid,bid+.01)],time+2000);assert.equal(closed.positions[0].status,'closed');
});
