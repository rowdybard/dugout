import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveTennisRules} from '../lib/tennis/auto.ts';
import {applyTennisAction,createTennisSession,defaultTennisConfig,stepTennisSession} from '../lib/tennis/engine.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types.ts';
const NOW=Date.parse('2026-09-25T21:00:00Z');
function input(time:number,bid:number,ask:number,slug='synthetic-auto',league:'ATP'|'WTA'='ATP'):TennisInput{
  return {receivedAt:time,source:'REST',book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{slug,eventId:slug,eventSlug:slug,title:'Synthetic Auto A vs B',league,yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,score:null,period:null,tournament:null,bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:null,history:[],execution:{slug,league,active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}}};
}
function queued(strategy:'recovery'|'momentum',slugs=['synthetic-auto'],league:'ATP'|'WTA'='ATP'){
  let session=applyTennisAction(createTennisSession({...defaultTennisConfig(),strategy:'auto',entryBudget:10},NOW-60000),{action:'start',commandId:'synthetic-start'},[],NOW-60000);
  for(let i=0;i<12;i++){const t=NOW-60000+i*4000;session=stepTennisSession(session,slugs.map(slug=>input(t,strategy==='recovery'?.71:.59,strategy==='recovery'?.72:.60,slug,league)),t);}
  const path=strategy==='recovery'?[[.61,.62],[.63,.64],[.64,.65]]:[[.61,.62],[.64,.65],[.64,.65]];
  path.forEach(([bid,ask],i)=>{const t=NOW-12000+i*5000;session=stepTennisSession(session,slugs.map(slug=>input(t,bid,ask,slug,league)),t);});
  return session;
}
test('automatic thresholds use prior quote noise, round to ticks, and do not change risk limits',()=>{
  const prior=[{time:1,price:.5,bid:.49},{time:2,price:.5,bid:.49},{time:3,price:.5,bid:.49}];
  const rules=adaptiveTennisRules(prior,.49,.5,.01,4)!;
  assert.deepEqual(rules,{declinePoints:3,recoveryPoints:1,momentumPoints:3,noisePoints:0});
  assert.deepEqual(adaptiveTennisRules([...prior,{time:5,price:.99,bid:.98}],.49,.5,.01,4),rules);
  const noisy=adaptiveTennisRules([{time:1,price:.4,bid:.39},{time:2,price:.42,bid:.41},{time:3,price:.44,bid:.43}],.49,.5,.01,4)!;
  assert.equal(noisy.momentumPoints,6);assert.equal(noisy.recoveryPoints,2);
  assert.equal(adaptiveTennisRules([{time:1,price:.1},{time:2,price:.9}],.49,.5,.01,3),null);
});
for(const strategy of ['recovery','momentum'] as const)for(const league of ['ATP','WTA'] as const)test(`Auto chooses ${strategy} on ${league}, waits for a later book, and preserves cash/provenance`,()=>{
  const session=queued(strategy,['synthetic-auto'],league),original=structuredClone(session);
  assert.equal(session.pending?.signalConfig?.strategy,strategy);assert.equal(session.pending?.decisionMode,'auto');
  assert.equal(session.pending?.action,'BUY');assert.equal(session.cash,100);assert.equal(session.ledger.length,0);assert.equal(session.positions.length,0);
  assert.equal(session.config.strategy,'auto');assert.equal(session.config.maxSpreadPoints,2);
  for(const history of Object.values(session.histories))assert.equal(new Set(history.map(p=>p.time)).size,history.length);
  assert.equal(new Set(session.decisions.map(d=>d.id)).size,session.decisions.length);
  const restored=JSON.parse(JSON.stringify(session)) as TennisSession;
  // A display track change cannot replace the selected signal's frozen provenance.
  restored.signals['synthetic-auto:YES']={phase:'WARMING',confirmations:0,reason:'Different display track'};
  const filled=stepTennisSession(restored,[input(NOW,.64,.65,'synthetic-auto',league)],NOW);
  assert.equal(filled.ledger[0]?.strategy,strategy);assert.equal(filled.positions[0]?.strategy,strategy);assert.ok(filled.cash<100);
  assert.deepEqual(session,original);
  const repeated=stepTennisSession(filled,[input(NOW,.64,.65,'synthetic-auto',league)],NOW+1);
  assert.equal(repeated.ledger.length,1);assert.equal(repeated.cash,filled.cash);
});
test('Auto compares all eligible matches and selects deterministically without staging multiple orders',()=>{
  const a=queued('momentum',['z-market','a-market']),b=queued('momentum',['a-market','z-market']);
  assert.equal(a.autoStatus?.qualified,2);assert.equal(a.pending?.slug,'a-market');assert.equal(b.pending?.slug,'a-market');
  assert.equal(a.ledger.length,0);assert.equal(a.cash,100);
});
test('Auto still rejects a widened execution book and cools both strategy tracks',()=>{
  const queuedSession=queued('momentum');
  const canceled=stepTennisSession(queuedSession,[input(NOW,.60,.65)],NOW);
  assert.equal(canceled.pending,null);assert.equal(canceled.cash,100);assert.equal(canceled.ledger.length,0);
  for(const side of ['YES','NO'])for(const strategy of ['recovery','momentum'])assert.equal(canceled.autoSignals?.[`synthetic-auto:${side}:${strategy}`]?.phase,'COOLDOWN');
});
test('Auto exit retains chosen strategy after a mode change and cooldown clears both candidates',()=>{
  let session=stepTennisSession(queued('recovery'),[input(NOW,.64,.65)],NOW);
  session=applyTennisAction(session,{action:'update-rules',sessionId:session.id,expectedRulesRevision:0,commandId:'synthetic-mode-change',rules:{strategy:'momentum'}},[],NOW+1);
  session=stepTennisSession(session,[input(NOW+2000,.75,.76)],NOW+2000);
  session=stepTennisSession(session,[input(NOW+4000,.75,.76)],NOW+4000);
  assert.equal(session.positions[0].status,'closed');assert.equal(session.ledger.at(-1)?.strategy,'recovery');
  for(const side of ['YES','NO'])for(const strategy of ['recovery','momentum'])assert.equal(session.autoSignals?.[`synthetic-auto:${side}:${strategy}`]?.phase,'COOLDOWN');
});
test('explicit rule changes cancel Auto pending entries and preserve the journal and cash',()=>{
  const session=queued('momentum');
  const result=applyTennisAction(session,{action:'update-rules',sessionId:session.id,expectedRulesRevision:0,commandId:'synthetic-rules-change',rules:{entryBudget:5}},[],NOW);
  assert.equal(result.pending,null);assert.equal(result.cash,100);assert.deepEqual(result.autoSignals,{});assert.deepEqual(result.ledger,session.ledger);
});
test('expired Auto entry cannot immediately create a replacement intent',()=>{
  const session=queued('momentum'),later=NOW+40000;
  const result=stepTennisSession(session,[input(later,.64,.65)],later);
  assert.equal(result.pending,null);assert.equal(result.ledger.length,0);assert.equal(result.cash,100);
  assert.ok(result.decisions.some(d=>d.code==='INTENT_EXPIRED'));
  assert.equal(result.autoSignals?.['synthetic-auto:YES:momentum'].phase,'COOLDOWN');
});
