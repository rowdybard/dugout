import test from 'node:test';
import assert from 'node:assert/strict';
import {executePaperCommand} from '../lib/trading/execution.ts';
import type {ExecutionMarket, ExecutionPolicy, PaperAccount, PaperCommand} from '../lib/trading/types.ts';
import type {Book} from '../lib/market/types.ts';
import {applyTennisAction,createTennisSession,defaultTennisConfig,stepTennisSession,tennisEquity} from '../lib/tennis/engine.ts';
import type {TennisInput,TennisSession} from '../lib/tennis/types.ts';

// Synthetic engineering scenarios only. These are not historical tennis games,
// real trades, strategy returns, or evidence of expected profitability.
const NOW = Date.parse('2026-09-25T21:00:00Z');
const close = (actual:number, expected:number) => assert.ok(Math.abs(actual-expected)<0.000002, `${actual} != ${expected}`);
const executionMarket = (league:'ATP'|'WTA'):ExecutionMarket => ({
  slug:`synthetic-${league.toLowerCase()}-winner`,league,active:true,
  minimumTradeQty:1,quantityIncrement:1,priceIncrement:0.01,feeCoefficient:0.0695,
});
const executionPolicy = (now=NOW):ExecutionPolicy => ({
  now,bookReceivedAt:now,bookSource:'REST',stateCertain:true,maxBookAgeMs:5000,
  maxCommandAgeMs:10000,maxOrderBudget:25,maxMarketExposure:25,maxTotalExposure:25,automation:'PAPER',
});
const paperAccount:PaperAccount={cash:100,marketExposure:0,totalExposure:0,availableQuantity:0};
const quote = (bid:number,ask:number,quantity=100,time=NOW):Book => ({
  state:'MARKET_STATE_OPEN',time:new Date(time).toISOString(),
  bids:[{price:bid,quantity}],asks:[{price:ask,quantity}],
});
const manual = (market:ExecutionMarket,side:'YES'|'NO',limitPrice:number):PaperCommand => ({
  commandId:`synthetic-${market.league}-${side}`,marketSlug:market.slug,
  side,action:'BUY',source:'MANUAL',budget:10,limitPrice,createdAt:NOW,
});

for(const league of ['ATP','WTA'] as const)for(const side of ['YES','NO'] as const){
  test(`${league} ${side}: paper buy uses that outcome's executable offer and never overspends`,()=>{
    const market=executionMarket(league),limit=side==='YES'?0.65:0.39;
    const result=executePaperCommand(manual(market,side,limit),paperAccount,market,quote(0.61,0.65),executionPolicy());
    assert.equal(result.status,'filled');assert.ok(result.filledQty>0);
    close(result.averagePrice,limit);assert.ok(-result.cashDelta<=10);
    close(result.gross+result.fees,-result.cashDelta);
    assert.ok(result.fees>0,'fee estimate must be included in the cash debit');
  });
}

test('tennis price display cannot substitute for executable depth on a delayed order',()=>{
  const market=executionMarket('ATP'),command=manual(market,'YES',0.40);
  const result=executePaperCommand(command,paperAccount,market,quote(0.44,0.46,100,NOW+1500),executionPolicy(NOW+1500));
  assert.equal(result.filledQty,0);assert.equal(result.cashDelta,0);assert.equal(result.apply,false);
});

test('tennis partial exit pays only for sold contracts and preserves the no-short-selling bound',()=>{
  const market=executionMarket('WTA'),command:PaperCommand={...manual(market,'NO',0.45),action:'SELL',budget:undefined,quantity:20};
  const result=executePaperCommand(command,{...paperAccount,availableQuantity:20},market,quote(0.51,0.55,3),executionPolicy());
  assert.equal(result.status,'partial');assert.equal(result.filledQty,3);assert.equal(result.remainingQty,17);
  close(result.averagePrice,0.45);close(result.cashDelta,1.35-result.fees);
  const excess=executePaperCommand({...command,quantity:21},{...paperAccount,availableQuantity:20},market,quote(0.51,0.55),executionPolicy());
  assert.equal(excess.apply,false);assert.equal(excess.cashDelta,0);
});

const tennisInput=(time:number,bid=0.39,ask=0.40,league:'ATP'|'WTA'='ATP',quantity=100):TennisInput=>{
  const execution=executionMarket(league);
  return {receivedAt:time,source:'REST',book:quote(bid,ask,quantity,time),market:{
    slug:execution.slug,eventId:`synthetic-${league}-event`,eventSlug:`synthetic-${league}-event`,
    title:'Synthetic Player A vs Player B',league,yesName:'Synthetic Player A',noName:'Synthetic Player B',
    startTime:new Date(NOW-30*60_000).toISOString(),live:true,ended:false,score:null,period:null,
    tournament:'Synthetic QA only',active:true,bid,ask,price:(bid+ask)/2,observedAt:time,
    contextUpdatedAt:null,history:[],execution,
  }};
};
const forSide=(time:number,bid:number,ask:number,side:'YES'|'NO'='YES',league:'ATP'|'WTA'='ATP',quantity=100)=>
  tennisInput(time,side==='YES'?bid:1-ask,side==='YES'?ask:1-bid,league,quantity);
function queued(side:'YES'|'NO'='YES',league:'ATP'|'WTA'='ATP',strategy:'recovery'|'momentum'='recovery') {
  let session=applyTennisAction(createTennisSession({...defaultTennisConfig(),strategy,entryBudget:10},NOW-60000),{action:'start',commandId:'start'},[],NOW-60000);
  for(let i=0;i<12;i++){
    const t=NOW-60000+i*4000;
    session=stepTennisSession(session,[forSide(t,strategy==='recovery'?.71:.59,strategy==='recovery'?.72:.60,side,league)],t);
  }
  const path=strategy==='recovery'?[[.61,.62],[.63,.64],[.64,.65]]:[[.61,.62],[.64,.65],[.64,.65]];
  path.forEach(([bid,ask],i)=>{const t=NOW-12000+i*5000;session=stepTennisSession(session,[forSide(t,bid,ask,side,league)],t);});
  assert.equal(session.pending?.action,'BUY');assert.equal(session.pending?.side,side);
  return session;
}
function bought(side:'YES'|'NO'='YES') {
  const session=queued(side),filled=stepTennisSession(session,[forSide(NOW,.64,.65,side)],NOW);
  assert.equal(filled.positions.length,1);return filled;
}

for(const strategy of ['recovery','momentum'] as const)for(const side of ['YES','NO'] as const)for(const league of ['ATP','WTA'] as const){
  test(`${strategy}: genuine ${league} ${side} signal waits for a fresh delayed fill`,()=>{
    const session=queued(side,league,strategy),at=session.pending!.executeAfter;
    assert.equal(session.cash,100);assert.equal(session.positions.length,0);
    const old=stepTennisSession(session,[forSide(at-1,.64,.65,side,league)],at);
    assert.equal(old.cash,100);assert.equal(old.positions.length,0);
    const filled=stepTennisSession(old,[forSide(at+1000,.64,.65,side,league)],at+1000);
    assert.equal(filled.positions.length,1);assert.equal(filled.ledger[0].source,'AUTOMATIC');
    close(filled.cash+filled.positions[0].entryCost,100);
    const replay=stepTennisSession(filled,[forSide(at+1000,.64,.65,side,league)],at+1001);
    close(replay.cash,filled.cash);assert.equal(replay.ledger.length,1);
  });
}

for(const defect of ['pregame','ended','suspended','catalog stale','book stale','future','replay','spread','buyers fell','price fell'] as const){
  test(`a delayed entry cancels or waits safely when ${defect}`,()=>{
    const session=queued(),input=tennisInput(NOW,.64,.65);
    if(defect==='pregame')input.market.live=false;
    if(defect==='ended')input.market.ended=true;
    if(defect==='suspended')input.market.active=false;
    if(defect==='catalog stale')input.market.observedAt=NOW-60000;
    if(defect==='book stale')input.receivedAt=NOW-60000;
    if(defect==='future')input.receivedAt=NOW+10000;
    if(defect==='replay')input.source='REPLAY';
    if(defect==='spread')input.book.asks[0].price=.68;
    if(defect==='buyers fell'){input.book.bids[0].price=.63;input.book.asks[0].price=.65;}
    if(defect==='price fell'){input.book.bids[0].price=.63;input.book.asks[0].price=.64;}
    const next=stepTennisSession(session,[input],NOW);
    assert.equal(next.cash,100);assert.equal(next.positions.length,0);
  });
}
test('pause cancels an entry and a duplicate command does not resume it',()=>{
  const session=queued(),action={action:'pause' as const,commandId:'pause'};
  const paused=applyTennisAction(session,action,[],NOW);
  assert.equal(paused.pending,null);assert.equal(paused.status,'paused');
  const repeated=applyTennisAction(paused,action,[],NOW+1000);assert.equal(repeated.revision,paused.revision);
});
test('partial bot exits cannot spend the same observed depth twice',()=>{
  const filled=bought(),time=NOW+3000;
  const requested=applyTennisAction(filled,{action:'stop',commandId:'stop'},[tennisInput(time,.72,.73,'ATP',3)],time);
  assert.ok(requested.pending);const at=requested.pending.executeAfter,book=tennisInput(at,.72,.73,'ATP',3);
  const partial=stepTennisSession(requested,[book],at);
  close(partial.positions[0].quantity,filled.positions[0].quantity-3);
  const again=stepTennisSession(partial,[book],at+1000);close(again.cash,partial.cash);
  close(again.positions[0].quantity,partial.positions[0].quantity);
});
test('settlement uses explicit provider value once even after a book disappears',()=>{
  for(const side of ['YES','NO'] as const){
    const filled=bought(side),input=tennisInput(NOW+5000);input.market.ended=true;input.market.active=false;
    input.book={bids:[],asks:[],state:'MARKET_STATE_EXPIRED',time:''};input.settlement=.5;input.settlementReceivedAt=NOW+5000;
    const settled=stepTennisSession(filled,[input],NOW+5000);assert.equal(settled.positions[0].status,'settled');
    close(settled.cash,filled.cash+filled.positions[0].quantity*.5);close(tennisEquity(settled),settled.cash);
    close(stepTennisSession(settled,[input],NOW+6000).cash,settled.cash);
  }
});
test('rising display prices are not profit until executable fees are covered',()=>{
  const filled=bought(),higher=stepTennisSession(filled,[tennisInput(NOW+4000,.67,.68)],NOW+4000);
  assert.ok(higher.positions[0].netLiquidationValue!<higher.positions[0].entryCost);
  assert.equal(higher.pending,null);
});
test('a vanished profit quote cannot become a successful exit',()=>{
  const filled=bought(),target=stepTennisSession(filled,[tennisInput(NOW+4000,.73,.74)],NOW+4000);
  assert.equal(target.pending?.action,'SELL');const at=target.pending!.executeAfter;
  const vanished=stepTennisSession(target,[tennisInput(at,.64,.65)],at);
  close(vanished.cash,filled.cash);assert.equal(vanished.positions[0].realizedPnl,0);
});
test('editing every rule preserves balance/history and cancels only a pending entry',()=>{
  const session=queued(),oldCash=session.cash;
  const next=applyTennisAction(session,{action:'update-rules',sessionId:session.id,commandId:'rules',expectedRulesRevision:0,
    rules:{strategy:'momentum',entryBudget:8,minSamples:8,baselineWindowMs:90000,minimumHistoryMs:40000,
      momentumPoints:4,momentumConfirmations:3,targetReturn:.04,stopReturn:.09,maxHoldMs:180000,cooldownMs:45000,
      executionDelayMs:2000,maxBookAgeMs:4000,maxSessionLossFraction:.15,leagues:['WTA']}},[],NOW);
  assert.equal(next.pending,null);assert.equal(next.cash,oldCash);assert.equal(next.id,session.id);assert.deepEqual(next.ledger,session.ledger);
  assert.equal(next.rulesRevision,1);assert.equal(next.config.strategy,'momentum');assert.deepEqual(next.histories,{});
  assert.ok(next.decisions.some(d=>d.code==='RULES_CANCELLED'));assert.equal(next.decisions.at(-1)?.rulesRevision,1);
  const stale=applyTennisAction(next,{action:'update-rules',sessionId:next.id,commandId:'stale',expectedRulesRevision:0,rules:{entryBudget:3}},[],NOW+1);
  assert.equal(stale.config.entryBudget,8);assert.match(stale.lastReason,/another tab/);
  const serialized=JSON.parse(JSON.stringify(next));assert.equal(serialized.config.momentumPoints,4);
});
test('rule changes preserve pending exits and held positions',()=>{
  const held=bought(),exiting=applyTennisAction(held,{action:'stop',commandId:'stop'},[tennisInput(NOW+1000,.72,.73)],NOW+1000);
  const changed=applyTennisAction(exiting,{action:'update-rules',sessionId:exiting.id,commandId:'rules-exit',expectedRulesRevision:0,rules:{targetReturn:.05}},[],NOW+1001);
  assert.deepEqual(changed.pending,exiting.pending);assert.deepEqual(changed.positions,exiting.positions);assert.equal(changed.cash,exiting.cash);
});
test('legacy pending user entries are canceled while historical fills stay untouched',()=>{
  const session=queued();session.pending!.source='MANUAL';
  const next=stepTennisSession(session,[tennisInput(NOW,.64,.65)],NOW);
  assert.equal(next.cash,100);assert.equal(next.positions.length,0);assert.ok(next.decisions.some(d=>d.code==='RETIRED_ENTRY'));
});
test('unsupported direct entry actions cannot change cash or create an intent',()=>{
  const session=applyTennisAction(createTennisSession(defaultTennisConfig(),NOW),{action:'start',commandId:'start'},[],NOW);
  const result=applyTennisAction(session,{action:'buy',slug:'x',amount:5,side:'YES',commandId:'retired'} as unknown as Parameters<typeof applyTennisAction>[1],[tennisInput(NOW)],NOW);
  assert.equal(result.cash,session.cash);assert.equal(result.pending,null);assert.match(result.lastReason,/Only bot/);
});
test('live observation time excludes outages and stale match status',()=>{
  let session=applyTennisAction(createTennisSession(defaultTennisConfig(),NOW),{action:'start',runForMs:60000,commandId:'start'},[],NOW);
  for(let i=1;i<12;i++)session=stepTennisSession(session,[],NOW+i*5000);
  const stale=tennisInput(NOW+60000,.64,.65);stale.market.observedAt=NOW-60000;
  session=stepTennisSession(session,[stale],NOW+60000);
  assert.equal(session.testRun?.watchedMs,0);assert.deepEqual(session.testRun?.liveSlugs,[]);assert.equal(session.testRun?.complete,true);
  assert.equal(session.status,'paused');assert.equal(session.coverage?.[stale.market.slug].live,false);
});
test('momentum cannot reuse a rise older than its baseline window',()=>{
  let s=applyTennisAction(createTennisSession({...defaultTennisConfig(),strategy:'momentum'},NOW),{action:'start',commandId:'start'},[],NOW);
  for(let i=0;i<12;i++)s=stepTennisSession(s,[tennisInput(NOW+i*4000,.59,.60)],NOW+i*4000);
  for(let i=0;i<34;i++){const at=NOW+48000+i*4000;s=stepTennisSession(s,[tennisInput(at,.64,.68)],at);}
  const at=NOW+184000;s=stepTennisSession(s,[tennisInput(at,.65,.67)],at);
  assert.equal(s.pending,null);assert.equal(s.positions.length,0);
});
test('fee-inclusive entry costs cannot start a position beyond its configured loss limit',()=>{
  for(const side of ['YES','NO'] as const){
    let s=applyTennisAction(createTennisSession(defaultTennisConfig(),NOW),{action:'start',commandId:'start'},[],NOW);
    for(let i=0;i<12;i++){const at=NOW+i*4000;s=stepTennisSession(s,[forSide(at,.59,.60,side)],at);}
    [[.07,.09],[.09,.11],[.10,.12]].forEach(([bid,ask],i)=>{const at=NOW+48000+i*4000;s=stepTennisSession(s,[forSide(at,bid,ask,side)],at);});
    assert.equal(s.pending,null);assert.equal(s.cash,100);assert.ok(s.rejectionCounts.ENTRY_COST>0);
  }
});
