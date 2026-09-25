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
const freshSession=():TennisSession=>{
  const config={...defaultTennisConfig(100),entryBudget:10};
  const session=createTennisSession(config,NOW);
  return applyTennisAction(session,{action:'start',commandId:'qa-start'},[],NOW);
};
const bought=(side:'YES'|'NO'='YES'):TennisSession=>{
  const input=tennisInput(NOW),session=applyTennisAction(freshSession(),{
    action:'buy',slug:input.market.slug,side,amount:10,commandId:`qa-buy-${side}`,
  },[input],NOW);
  assert.ok(session.pending,'manual buy must record an intent first');
  const time=session.pending.executeAfter;
  const filled=stepTennisSession(session,[tennisInput(time)],time);
  assert.equal(filled.positions.filter(p=>p.status==='open').length,1);
  return filled;
};

test('website paper buy waits for both latency and a later authoritative book',()=>{
  const input=tennisInput(NOW),initial=freshSession();
  const queued=applyTennisAction(initial,{action:'buy',slug:input.market.slug,side:'YES',amount:10,commandId:'qa-delay'},[input],NOW);
  close(queued.cash,100);assert.equal(queued.positions.length,0);assert.ok(queued.pending);
  const before=stepTennisSession(queued,[tennisInput(NOW+500)],NOW+500);
  close(before.cash,100);assert.equal(before.positions.length,0);
  const delayed=stepTennisSession(before,[input],queued.pending.executeAfter+2000);
  close(delayed.cash,100);assert.equal(delayed.positions.length,0,'the original quote cannot become a delayed fill');
  const time=queued.pending.executeAfter+2001;
  const moved=stepTennisSession(delayed,[tennisInput(time,0.44,0.46)],time);
  close(moved.cash,100);assert.equal(moved.positions.length,0,'new execution price exceeded the recorded limit');
});

test('manual tennis buys and repeated command submission preserve one cash debit',()=>{
  for(const side of ['YES','NO'] as const){
    const filled=bought(side),position=filled.positions.find(p=>p.status==='open')!;
    assert.equal(position.side,side);close(position.entryPrice,side==='YES'?0.40:0.61);
    close(filled.cash+position.entryCost,100);assert.ok(position.entryCost<=10);
    const replay=applyTennisAction(filled,{action:'buy',slug:position.slug,side,amount:10,commandId:`qa-buy-${side}`},[tennisInput(NOW+2000)],NOW+2000);
    close(replay.cash,filled.cash);assert.equal(replay.positions.length,filled.positions.length);assert.equal(replay.ledger.length,filled.ledger.length);
  }
});

test('a partial manual exit cannot spend the same observed depth twice',()=>{
  const filled=bought(),position=filled.positions.find(p=>p.status==='open')!;
  const time=NOW+3000,input=tennisInput(time,0.48,0.49,'ATP',3);
  const requested=applyTennisAction(filled,{action:'close',positionId:position.id,commandId:'qa-close'},[input],time);
  assert.ok(requested.pending);const afterDelay=requested.pending.executeAfter;
  const partialBook=tennisInput(afterDelay,0.48,0.49,'ATP',3);
  const partial=stepTennisSession(requested,[partialBook],afterDelay);
  const held=partial.positions.find(p=>p.id===position.id)!;
  assert.equal(held.status,'open');close(held.quantity,position.quantity-3);
  assert.ok(held.costBasis>0);assert.ok(held.proceeds>0);assert.ok(held.exitFees>0);
  const repeated=stepTennisSession(partial,[partialBook],afterDelay+2000);
  close(repeated.cash,partial.cash);close(repeated.positions.find(p=>p.id===position.id)!.quantity,held.quantity);
  close(partial.cash,100-position.entryCost+held.proceeds);
});

test('stale and future inputs cannot create a paper fill or a profitable liquidation mark',()=>{
  for(const receivedAt of [NOW-60_000,NOW+60_000]){
    const initial=freshSession(),input=tennisInput(receivedAt);
    let next=initial;
    try{next=applyTennisAction(initial,{action:'buy',slug:input.market.slug,side:'YES',amount:10,commandId:`qa-bad-time-${receivedAt}`},[input],NOW);}catch{}
    close(next.cash,100);assert.equal(next.positions.length,0);
    const stepped=stepTennisSession(next,[input],NOW+1000);
    close(stepped.cash,100);assert.equal(stepped.positions.length,0);
  }
});

test('settlement uses only fresh confirmed provider results and applies once',()=>{
  const filled=bought('NO'),position=filled.positions.find(p=>p.status==='open')!,time=NOW+5000;
  const input=tennisInput(time);input.market.ended=true;input.market.active=false;
  input.settlement=0;input.settlementReceivedAt=time;
  const settled=stepTennisSession(filled,[input],time);
  assert.equal(settled.positions.find(p=>p.id===position.id)!.status,'settled');
  close(settled.cash,filled.cash+position.quantity);
  close(tennisEquity(settled),settled.cash);
  const repeated=stepTennisSession(settled,[input],time+1000);
  close(repeated.cash,settled.cash);assert.equal(repeated.ledger.length,settled.ledger.length);
});

test('an explicit final fair-price settlement reconciles a removed tennis book',()=>{
  for(const side of ['YES','NO'] as const){
    const filled=bought(side),position=filled.positions.find(p=>p.status==='open')!,time=NOW+5000;
    const input=tennisInput(time);input.market.ended=true;input.market.active=false;
    input.market.execution!.active=false;input.book={bids:[],asks:[],state:'MARKET_STATE_EXPIRED',time:''};
    input.settlement=0.5;input.settlementReceivedAt=time;
    const settled=stepTennisSession(filled,[input],time);
    assert.equal(settled.positions.find(p=>p.id===position.id)!.status,'settled');
    close(settled.cash,filled.cash+position.quantity*0.5);
    close(settled.positions.find(p=>p.id===position.id)!.realizedPnl,position.quantity*0.5-position.entryCost);
  }
});

const warmed=()=>{
  let session=freshSession(),time=NOW;
  for(let i=0;i<16;i++){
    time=NOW+i*5000;
    session=stepTennisSession(session,[tennisInput(time,0.59,0.60)],time);
  }
  assert.equal(session.positions.length,0,'a steady market must not manufacture a recovery');
  assert.equal(session.pending,null);
  return {session,time};
};

test('automatic recovery requires a decline, a later executable bounce, then delayed execution',()=>{
  let {session,time}=warmed();
  for(const [bid,ask] of [[0.50,0.51],[0.49,0.50]]){
    time+=5000;session=stepTennisSession(session,[tennisInput(time,bid,ask)],time);
    assert.equal(session.pending,null,'a continuing decline must not trigger buy-the-dip by itself');
    assert.equal(session.positions.length,0);
  }
  for(const [bid,ask] of [[0.51,0.52],[0.52,0.53]]){
    time+=5000;session=stepTennisSession(session,[tennisInput(time,bid,ask)],time);
  }
  assert.equal(session.pending?.action,'BUY');assert.equal(session.pending?.side,'YES');
  close(session.cash,100);assert.equal(session.positions.length,0,'a signal is not a paper fill');
  const delayed=session.pending!.executeAfter;
  const filled=stepTennisSession(session,[tennisInput(delayed,0.52,0.53)],delayed);
  assert.equal(filled.positions.filter(p=>p.status==='open').length,1);
  assert.ok(filled.cash<100);assert.ok(filled.ledger.some(e=>e.source==='AUTOMATIC'&&e.action==='BUY'));
});

test('an ask-only rise cannot manufacture a confirmed recovery',()=>{
  let {session,time}=warmed();
  session.config.maxSpreadPoints=4;
  time+=5000;session=stepTennisSession(session,[tennisInput(time,0.49,0.50)],time);
  for(let i=0;i<3;i++){
    time+=5000;session=stepTennisSession(session,[tennisInput(time,0.49,0.52)],time);
  }
  assert.equal(session.pending,null);assert.equal(session.positions.length,0);
  close(session.cash,100);
});

test('pause cancels an automatic entry before its fill and cannot silently resume it',()=>{
  let {session,time}=warmed();
  for(const [bid,ask] of [[0.49,0.50],[0.51,0.52],[0.52,0.53]]){
    time+=5000;session=stepTennisSession(session,[tennisInput(time,bid,ask)],time);
  }
  assert.equal(session.pending?.action,'BUY');
  const paused=applyTennisAction(session,{action:'pause',commandId:'qa-pause'},[],time+1);
  assert.equal(paused.status,'paused');
  const stepped=stepTennisSession(paused,[tennisInput(time+5000,0.52,0.53)],time+5000);
  assert.equal(stepped.positions.length,0);assert.equal(stepped.pending,null);close(stepped.cash,100);
});

test('a higher tennis chart price cannot trigger the net profit target before fees are covered',()=>{
  const filled=bought(),time=NOW+4000;
  const higher=stepTennisSession(filled,[tennisInput(time,0.43,0.44)],time);
  const position=higher.positions.find(p=>p.status==='open')!;
  assert.ok(position.netLiquidationValue!==null&&position.netLiquidationValue<position.entryCost,
    'at this fee rate the displayed three-cent rise still has a negative executable result');
  assert.equal(higher.pending,null,'the bot must not confuse a green chart with realized profit');
});

test('a vanished profit quote cannot become a successful paper exit',()=>{
  const filled=bought(),time=NOW+4000;
  const target=stepTennisSession(filled,[tennisInput(time,0.48,0.49)],time);
  assert.equal(target.pending?.action,'SELL');
  const delay=target.pending!.executeAfter;
  const vanished=stepTennisSession(target,[tennisInput(delay,0.39,0.40)],delay);
  close(vanished.cash,filled.cash);
  assert.equal(vanished.positions.find(p=>p.status==='open')!.quantity,filled.positions[0].quantity);
  assert.equal(vanished.positions[0].realizedPnl,0);
});

test('pause and resume cannot erase a requested exit or resurrect a stopped experiment',()=>{
  const stopped=applyTennisAction(freshSession(),{action:'stop',commandId:'qa-stop-empty'},[],NOW+1000);
  assert.equal(stopped.status,'stopped');
  const paused=applyTennisAction(stopped,{action:'pause',commandId:'qa-pause-stopped'},[],NOW+2000);
  const resumed=applyTennisAction(paused,{action:'resume',commandId:'qa-resume-stopped'},[],NOW+3000);
  assert.equal(resumed.status,'stopped');

  const filled=bought(),position=filled.positions.find(p=>p.status==='open')!;
  const closing=applyTennisAction(filled,{action:'close',positionId:position.id,commandId:'qa-close-without-feed'},[],NOW+3000);
  assert.equal(closing.status,'stopping');
  const pausing=applyTennisAction(closing,{action:'pause',commandId:'qa-pause-exit'},[],NOW+4000);
  assert.equal(pausing.status,'stopping','an exit request must survive unavailable prices and unrelated controls');
});
