import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveTennisRules} from '../lib/tennis/auto.ts';
import {quoteAvailabilityIssue} from '../lib/tennis/quote-status.ts';
import {focusedEntryRest} from '../lib/tennis/entry-rest.ts';
import {currentTennisContext,retainedTennisContext} from '../lib/tennis/market-context.ts';
import {applyTennisAction,createTennisSession,defaultTennisConfig,stepTennisSession} from '../lib/tennis/engine.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types.ts';
const NOW=Date.parse('2026-09-25T21:00:00Z');
test('unusable or inconsistent quotes explain the blocked entry',()=>{
  assert.match(quoteAvailabilityIssue(null,.01)!,/No usable buyers/);
  assert.match(quoteAvailabilityIssue(0,.01)!,/No usable buyers/);
  assert.match(quoteAvailabilityIssue(.99,null)!,/No usable sellers/);
  assert.match(quoteAvailabilityIssue(null,null)!,/No usable buying or selling/);
  assert.match(quoteAvailabilityIssue(.8,.7)!,/disagree/);
  assert.equal(quoteAvailabilityIssue(.7,.71),null);
});
function input(time:number,bid:number,ask:number,slug='synthetic-auto',league:'ATP'|'WTA'|'NFL'|'CFB'='ATP'):TennisInput{
  return {receivedAt:time,source:'REST',book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},market:{slug,eventId:slug,eventSlug:slug,title:'Synthetic Auto A vs B',league,yesName:'Synthetic A',noName:'Synthetic B',startTime:new Date(NOW-600000).toISOString(),live:true,ended:false,active:true,score:null,period:null,tournament:null,bid,ask,price:(bid+ask)/2,observedAt:time,contextUpdatedAt:null,history:[],execution:{slug,league,active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695}}};
}
function queued(strategy:'recovery'|'momentum',slugs=['synthetic-auto'],league:'ATP'|'WTA'|'NFL'|'CFB'='ATP'){
  let session=applyTennisAction(createTennisSession({...defaultTennisConfig(),strategy:'auto',entryBudget:10,leagues:[league]},NOW-60000),{action:'start',commandId:'synthetic-start'},[],NOW-60000);
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
for(const strategy of ['recovery','momentum'] as const)for(const league of ['ATP','WTA','NFL','CFB'] as const)test(`Auto chooses ${strategy} on ${league}, waits for a later book, and preserves cash/provenance`,()=>{
  const session=queued(strategy,['synthetic-auto'],league),original=structuredClone(session);
  assert.equal(session.pending?.signalConfig?.strategy,strategy);assert.equal(session.pending?.decisionMode,'auto');
  assert.equal(session.pending?.action,'BUY');assert.equal(session.cash,100);assert.equal(session.ledger.length,0);assert.equal(session.positions.length,0);
  assert.match(session.autoSignals![`synthetic-auto:YES:${strategy}`].reason,/Waiting at least/);
  assert.doesNotMatch(session.autoSignals![`synthetic-auto:YES:${strategy}`].reason,/Rise: Rise:|Recovery: Recovery:/);
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
  const waiting=stepTennisSession(canceled,[input(NOW+2000,.64,.65)],NOW+2000);
  assert.match(waiting.lastReason,/Entry cooldown: 8s/);
  assert.match(waiting.lastReason,/resumes automatically/);
  assert.equal(waiting.pending,null);assert.equal(waiting.cash,100);
});
test('ticks without a new book preserve the last Auto explanation and check time',()=>{
  const canceled=stepTennisSession(queued('momentum'),[input(NOW,.60,.65)],NOW);
  const book=input(NOW+2000,.64,.65);
  const waiting=stepTennisSession(canceled,[book],NOW+2000);
  for(const inputs of [[book],[]]){
    const repeated=stepTennisSession(waiting,inputs,NOW+3000);
    assert.equal(repeated.lastReason,waiting.lastReason);
    assert.deepEqual(repeated.autoStatus,waiting.autoStatus);
    assert.deepEqual(repeated.decisions,waiting.decisions);
    assert.equal(repeated.cash,waiting.cash);assert.equal(repeated.pending,null);
  }
  const stale=stepTennisSession(waiting,[book],NOW+8000);
  assert.notEqual(stale.lastReason,waiting.lastReason);
  assert.equal(stale.decisions.at(-1)?.code,'DATA');
});

test('focused entry rest counts down only while every eligible Auto track is resting',()=>{
  const canceled=stepTennisSession(queued('momentum'),[input(NOW,.60,.65)],NOW);
  canceled.config.focusSlug='synthetic-auto';
  assert.equal(focusedEntryRest(canceled,NOW),10);
  assert.equal(focusedEntryRest(canceled,NOW+2500),8);
  assert.equal(focusedEntryRest(canceled,NOW+10000),null);
  const oneReady=structuredClone(canceled);
  oneReady.autoSignals!['synthetic-auto:NO:momentum'].cooldownUntil=NOW;
  assert.equal(focusedEntryRest(oneReady,NOW),null);
  delete oneReady.autoSignals!['synthetic-auto:NO:momentum'];
  assert.equal(focusedEntryRest(oneReady,NOW),null);
  const fixed=structuredClone(canceled);fixed.config.strategy='recovery';delete fixed.autoSignals;
  assert.equal(focusedEntryRest(fixed,NOW),10);
  fixed.signals['synthetic-auto:YES'].cooldownUntil=NOW+4000;
  assert.equal(focusedEntryRest(fixed,NOW+1000),3);
});

test('entry rest cannot hide held, pending, paused, stale or other-game activity',()=>{
  const canceled=stepTennisSession(queued('momentum'),[input(NOW,.60,.65)],NOW);
  canceled.config.focusSlug='synthetic-auto';
  for(const changed of [
    {...canceled,status:'paused' as const},
    {...canceled,lastTickAt:NOW-20001},
    {...canceled,lastTickAt:NOW+1},
    {...canceled,config:{...canceled.config,focusSlug:null}},
    {...canceled,pending:queued('momentum').pending},
    {...canceled,positions:stepTennisSession(queued('momentum'),[input(NOW,.64,.65)],NOW).positions},
  ])assert.equal(focusedEntryRest(changed,NOW),null);
  assert.equal(focusedEntryRest(null,NOW),null);
  assert.equal(focusedEntryRest(canceled,NaN),null);
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

test('unfilled entries retry soon while completed trades retain the full configured rest',()=>{
  const prepared=queued('momentum');prepared.config.cooldownMs=300000;
  const canceled=stepTennisSession(prepared,[input(NOW,.60,.65)],NOW);
  assert.equal(canceled.signals['synthetic-auto:YES'].cooldownUntil,NOW+10000);
  assert.equal(canceled.cash,100);assert.equal(canceled.positions.length,0);
  assert.equal(stepTennisSession(canceled,[input(NOW+5000,.64,.65)],NOW+5000).pending,null);
  let filled=stepTennisSession(prepared,[input(NOW,.64,.65)],NOW);
  filled=stepTennisSession(filled,[input(NOW+2000,.75,.76)],NOW+2000);
  filled=stepTennisSession(filled,[input(NOW+4000,.75,.76)],NOW+4000);
  assert.equal(filled.positions[0].status,'closed');
  assert.equal(filled.signals['synthetic-auto:YES'].cooldownUntil,NOW+304000);
});

test('verified held-match context keeps live observation counting without changing the position',()=>{
  const held=stepTennisSession(queued('momentum'),[input(NOW,.64,.65)],NOW);
  held.config.maxHoldMs=1200000;
  held.testRun={startedAt:NOW,endsAt:NOW+10800000,watchedMs:0,lastCheckAt:NOW+89000,startingCash:100,startingLedgerCount:0,liveSlugs:[],complete:false};
  const later=NOW+90000,book=input(later,.64,.65),stored=held.positions[0].market;
  const stale=stepTennisSession(held,[{...book,market:stored}],later);
  assert.equal(stale.testRun?.watchedMs,0);
  const context=currentTennisContext(stored,{...book.market,score:'0-7',contextUpdatedAt:later-3000},later);
  const fresh=stepTennisSession(held,[{...book,market:context}],later);
  assert.equal(fresh.testRun?.watchedMs,1000);assert.equal(fresh.cash,held.cash);
  assert.equal(fresh.positions[0].status,'open');assert.equal(fresh.positions[0].entryPrice,held.positions[0].entryPrice);
  assert.equal(context.contextUpdatedAt,later-3000);assert.equal(context.observedAt,later);
  assert.equal(stored.observedAt,NOW);
});

test('held-match context never invents freshness or accepts a changed outcome mapping',()=>{
  const stored=input(NOW,.64,.65).market,now=NOW+90000;
  for(const latest of [undefined,{...stored,observedAt:NOW+1},{...stored,observedAt:now+1},{...stored,observedAt:NaN},
    {...stored,observedAt:now,slug:'different'}, {...stored,observedAt:now,league:'CFB' as const},
    {...stored,observedAt:now,eventId:'different'}, {...stored,observedAt:now,yesName:stored.noName,noName:stored.yesName}]){
    assert.equal(currentTennisContext(stored,latest,now),stored);
  }
  const ended=currentTennisContext(stored,{...stored,observedAt:now,ended:true,live:false,active:false},now);
  assert.equal(ended.ended,true);assert.equal(ended.active,false);
  const closedRules={...stored,active:false,execution:{...stored.execution!,active:false}};
  const updated=currentTennisContext(closedRules,{...stored,observedAt:now,score:'0-7'},now);
  assert.equal(updated.active,false);assert.equal(updated.execution,closedRules.execution);
  assert.equal(updated.observedAt,now);assert.equal(updated.score,'0-7');
});

test('held context survives a missed refresh without regressing or renewing its freshness',()=>{
  let held=stepTennisSession(queued('momentum'),[input(NOW,.64,.65)],NOW);
  held.config.maxHoldMs=1200000;
  const original=structuredClone(held.positions[0].market),later=NOW+90000;
  const fresh={...input(later,.64,.65),market:{...input(later,.64,.65).market,score:'0-7',contextUpdatedAt:later-3000}};
  held=stepTennisSession(held,[fresh],later);
  assert.equal(held.positions[0].lastContext?.score,'0-7');
  assert.deepEqual(held.positions[0].market,original); // Exchange metadata retains its independent original age.
  const restored=JSON.parse(JSON.stringify(held)) as TennisSession;
  const missedAt=later+50000;
  const retained=retainedTennisContext(original,restored.positions[0].lastContext,missedAt);
  assert.equal(currentTennisContext(retained,undefined,missedAt).score,'0-7');
  assert.equal(currentTennisContext(retained,original,missedAt).observedAt,later);
  assert.equal(currentTennisContext(retained,{...original,observedAt:missedAt,contextUpdatedAt:NOW},missedAt),retained);
  restored.testRun={startedAt:NOW,endsAt:NOW+10800000,watchedMs:0,lastCheckAt:missedAt-1000,startingCash:100,startingLedgerCount:0,liveSlugs:[],complete:false};
  const result=stepTennisSession(restored,[{...input(missedAt,.64,.65),market:retained}],missedAt);
  assert.equal(result.positions[0].lastContext?.score,'0-7');assert.equal(result.testRun?.watchedMs,0);
  assert.equal(result.cash,held.cash);assert.deepEqual(result.ledger,held.ledger);
});

test('resumed game context can replace a suspension while closed exchange rules still block activity',()=>{
  const original=input(NOW,.64,.65).market;
  const paused=currentTennisContext(original,{...original,observedAt:NOW+1000,active:false,period:'SUSPENDED'},NOW+1000);
  const later={...original,observedAt:NOW+2000,period:'Q2'};
  const resumed=currentTennisContext(paused,later,NOW+2000,original.active);
  assert.equal(resumed.active,true);assert.equal(resumed.period,'Q2');
  const closed={...paused,execution:{...original.execution!,active:false}};
  assert.equal(currentTennisContext(closed,later,NOW+2000,false).active,false);
});
test('expired Auto entry cannot immediately create a replacement intent',()=>{
  const session=queued('momentum'),later=NOW+40000;
  const result=stepTennisSession(session,[input(later,.64,.65)],later);
  assert.equal(result.pending,null);assert.equal(result.ledger.length,0);assert.equal(result.cash,100);
  assert.ok(result.decisions.some(d=>d.code==='INTENT_EXPIRED'));
  assert.equal(result.autoSignals?.['synthetic-auto:YES:momentum'].phase,'COOLDOWN');
});

test('Auto replaces old strategy reasons and confirmations when usable buyers disappear',()=>{
  const session=queued('momentum');session.pending=null;
  const oneSided=input(NOW,.99,.995);oneSided.book.asks=[];
  const result=stepTennisSession(session,[oneSided],NOW);
  assert.equal(result.pending,null);assert.equal(result.cash,100);assert.equal(result.ledger.length,0);
  assert.match(result.lastReason,/No usable buyers/);
  for(const strategy of ['recovery','momentum']){
    const track=result.autoSignals![`synthetic-auto:NO:${strategy}`];
    assert.match(track.reason,/No usable buyers/);assert.equal(track.confirmations,0);
    assert.equal(track.lastObservedAt,NOW);
  }
  assert.match(result.signals['synthetic-auto:NO'].reason,/No usable buyers/);
  assert.ok(result.decisions.some(d=>d.code==='BOOK'&&d.side==='NO'&&d.time===NOW));
});

test('switching to football cancels tennis entry intents but keeps held tennis exits working',()=>{
  const queuedSession=queued('momentum');
  const action={action:'update-rules' as const,sessionId:queuedSession.id,expectedRulesRevision:0,commandId:'football-switch',rules:{leagues:['NFL','CFB'] as ('NFL'|'CFB')[],focusSlug:'focused-football'}};
  const canceled=applyTennisAction(queuedSession,action,[],NOW);assert.equal(canceled.pending,null);assert.equal(canceled.cash,100);
  let held=stepTennisSession(queuedSession,[input(NOW,.64,.65)],NOW);
  const cash=held.cash,ledger=structuredClone(held.ledger);
  held=applyTennisAction(held,action,[],NOW+1);
  assert.equal(held.cash,cash);assert.deepEqual(held.ledger,ledger);assert.equal(held.positions[0].status,'open');
  held=stepTennisSession(held,[input(NOW+2000,.75,.76)],NOW+2000);assert.equal(held.pending?.action,'SELL');
  held=stepTennisSession(held,[input(NOW+4000,.75,.76)],NOW+4000);assert.equal(held.positions[0].status,'closed');assert.equal(held.ledger.at(-1)?.action,'SELL');
});

test('focused game is the only eligible entry and focus is rechecked at execution',()=>{
  const prepared=queued('momentum',['a-market','b-market'],'CFB');
  prepared.pending=null;prepared.config.focusSlug='b-market';
  const result=stepTennisSession(prepared,[input(NOW,.64,.65,'a-market','CFB'),input(NOW,.64,.65,'b-market','CFB')],NOW);
  assert.equal(result.pending?.slug,'b-market');
  const restricted=structuredClone(result);restricted.config.focusSlug='a-market';
  const blocked=stepTennisSession(restricted,[input(NOW+2000,.64,.65,'b-market','CFB')],NOW+2000);
  assert.equal(blocked.pending,null);assert.equal(blocked.cash,100);assert.equal(blocked.ledger.length,0);
  assert.ok(blocked.decisions.some(d=>d.code==='FOCUS'));
});

test('saving focused-game rules cancels buys, retains rest deadlines and preserves saved money',()=>{
  const prepared=queued('momentum');
  prepared.signals['other:YES']={phase:'COOLDOWN',confirmations:0,cooldownUntil:NOW+300000,reason:'Resting'};
  prepared.autoSignals!['other:YES:momentum']={phase:'COOLDOWN',confirmations:0,cooldownUntil:NOW+300000,reason:'Resting'};
  const result=applyTennisAction(prepared,{action:'update-rules',sessionId:prepared.id,expectedRulesRevision:0,commandId:'focus-change',rules:{focusSlug:'other',targetReturn:.2,maxHoldMs:1200000}},[],NOW);
  assert.equal(result.pending,null);assert.equal(result.cash,100);assert.deepEqual(result.ledger,prepared.ledger);
  assert.equal(result.signals['other:YES'].cooldownUntil,NOW+300000);
  assert.equal(result.autoSignals!['other:YES:momentum'].cooldownUntil,NOW+300000);
  const reset=applyTennisAction(result,{action:'reset',bankroll:100,commandId:'focus-reset'},[],NOW+1);
  assert.equal(reset.config.focusSlug,'other');
});

test('persisted provider ordering blocks an older REST MISS from marking or exiting a held position',()=>{
  const entry={...input(NOW,.64,.65),source:'WEBSOCKET' as const,sourceTime:NOW-100};
  const held=stepTennisSession(queued('momentum'),[entry],NOW);
  assert.equal(held.bookSourceTimes?.['synthetic-auto'],NOW-100);
  const restored=JSON.parse(JSON.stringify(held)) as TennisSession;
  const stale={...input(NOW+3000,.4,.41),sourceTime:NOW-120000,restReceipt:{requestedAt:NOW+3000,receivedAt:NOW+3032,cacheStatus:'MISS',cacheAgeSeconds:null}};
  const rejected=stepTennisSession(restored,[stale],NOW+3100);
  assert.equal(rejected.pending,null);assert.equal(rejected.positions[0].status,'open');
  assert.equal(rejected.positions[0].netLiquidationValue,null);assert.equal(rejected.positions[0].markedAt,null);
  assert.equal(rejected.cash,held.cash);assert.deepEqual(rejected.ledger,held.ledger);
  assert.deepEqual(rejected.quotes,held.quotes);assert.deepEqual(rejected.coverage,held.coverage);
  assert.deepEqual(rejected.consumedBooks,held.consumedBooks);assert.deepEqual(rejected.bookSourceTimes,held.bookSourceTimes);
  assert.equal(rejected.testRun?.watchedMs,held.testRun?.watchedMs);
  assert.equal(rejected.decisions.at(-1)?.code,'BOOK_ORDER');
  const current=stepTennisSession(rejected,[{...input(NOW+5000,.4,.41),sourceTime:NOW+4900}],NOW+5000);
  assert.equal(current.pending?.action,'SELL');assert.equal(current.bookSourceTimes?.['synthetic-auto'],NOW+4900);
  const waiting=stepTennisSession(current,[{...stale,receivedAt:NOW+7000}],NOW+7000);
  assert.equal(waiting.pending?.id,current.pending?.id);assert.equal(waiting.cash,current.cash);
  assert.deepEqual(waiting.ledger,current.ledger);
  const exited=stepTennisSession(waiting,[{...input(NOW+9000,.4,.41),sourceTime:NOW+8900}],NOW+9000);
  assert.equal(exited.positions[0].status,'closed');assert.equal(exited.ledger.at(-1)?.action,'SELL');
});

test('provider ordering blocks pending buys and entries without consuming their books or histories',()=>{
  const prepared=queued('momentum');prepared.bookSourceTimes={'synthetic-auto':NOW-100};
  const old={...input(NOW,.64,.65),sourceTime:NOW-120000};
  const pending=stepTennisSession(prepared,[old],NOW);
  assert.equal(pending.pending?.id,prepared.pending?.id);assert.equal(pending.ledger.length,0);assert.equal(pending.cash,100);
  assert.deepEqual(pending.histories,prepared.histories);
  const scanning=structuredClone(prepared);scanning.pending=null;
  const rejected=stepTennisSession(scanning,[old],NOW);
  assert.equal(rejected.pending,null);assert.deepEqual(rejected.histories,scanning.histories);
  assert.deepEqual(rejected.autoSignals,scanning.autoSignals);assert.deepEqual(rejected.consumedBooks,scanning.consumedBooks);
});

test('equal provider times remain usable while unknown or future times cannot overwrite a known book',()=>{
  const held=stepTennisSession(queued('momentum'),[{...input(NOW,.64,.65),sourceTime:NOW-100}],NOW);
  for(const sourceTime of [undefined,null,NaN,Infinity,NOW+9001]){
    const result=stepTennisSession(held,[{...input(NOW+2000,.64,.65),sourceTime}],NOW+2000);
    assert.equal(result.positions[0].netLiquidationValue,null);assert.deepEqual(result.bookSourceTimes,held.bookSourceTimes);
    assert.equal(result.decisions.at(-1)?.code,'BOOK_ORDER');
  }
  const equal=stepTennisSession(held,[{...input(NOW+2000,.64,.65),sourceTime:NOW-100}],NOW+2000);
  assert.notEqual(equal.positions[0].netLiquidationValue,null);assert.equal(equal.positions[0].markedAt,NOW+2000);
  const staleReceipt=stepTennisSession(held,[{...input(NOW,.64,.65),sourceTime:NOW+5900}],NOW+6000);
  assert.equal(staleReceipt.positions[0].netLiquidationValue,null);assert.deepEqual(staleReceipt.bookSourceTimes,held.bookSourceTimes);
});

test('explicit settlement still closes a position when its empty book cannot pass provider ordering',()=>{
  const held=stepTennisSession(queued('momentum'),[{...input(NOW,.64,.65),sourceTime:NOW-100}],NOW);
  const final={...input(NOW+2000,.64,.65),sourceTime:null,book:{bids:[],asks:[],state:'MARKET_STATE_EXPIRED',time:''},settlement:1,settlementReceivedAt:NOW+2000};
  const settled=stepTennisSession(held,[final],NOW+2000);
  assert.equal(settled.positions[0].status,'settled');assert.equal(settled.ledger.at(-1)?.action,'SETTLE');
  assert.equal(stepTennisSession(settled,[final],NOW+3000).cash,settled.cash);
});

test('a three-hour football observation preserves the entry pause at its actual end',()=>{
  const session=createTennisSession({...defaultTennisConfig(),strategy:'auto',leagues:['CFB']},NOW);
  const running=applyTennisAction(session,{action:'start',runForMs:10800000,commandId:'football-long-watch'},[],NOW);
  assert.equal(running.testRun?.endsAt,NOW+10800000);
  assert.equal(stepTennisSession(running,[],NOW+1800001).status,'running');
  const ended=stepTennisSession(running,[],NOW+10800000);
  assert.equal(ended.status,'paused');assert.equal(ended.testRun?.complete,true);
});
