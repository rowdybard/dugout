import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveExecutor,liveOrderRequest,type LiveIntent,type LiveTick} from '../lib/live/executor.ts';
import {DEFAULT_LIVE_LIMITS,emptyLiveState,LIVE_HARD_LIMITS,type LiveState} from '../lib/live/state.ts';
import {decide} from '../lib/decision/engine.ts';
import {FakeExchange} from './helpers/fake-exchange.ts';

const SLUG='aec-cfb-home-away-2026-10-03';
const T0=Date.parse('2026-10-03T18:00:00Z');
function harness(enabled=true){
  const exchange=new FakeExchange();
  let saved:LiveState=emptyLiveState();const saves:LiveState[]=[];
  const store={load:()=>structuredClone(saved),save:(state:LiveState)=>{saved=structuredClone(state);saves.push(saved);}};
  let n=0;
  const executor=createLiveExecutor({exchange,store,enabled,id:()=>`cmd-${++n}`});
  const arm=(over:Partial<Parameters<typeof executor.arm>[0]>={})=>executor.arm({mode:'pilot',focusSlug:SLUG,limits:{...DEFAULT_LIVE_LIMITS},priceIncrement:.005,minimumTradeQty:1,...over},T0);
  // Real engine verdicts: CFB pregame resting orders are a lead, permitted only as a capped pilot.
  const gate=(intent:LiveIntent)=>decide({sport:'CFB',phase:'pregame',style:intent.style==='maker'?'maker':'taker-hold',mode:'pilot',ask:intent.price+.01,bid:intent.price});
  const tick=(time:number,intents:LiveIntent[],over:Partial<LiveTick>={})=>executor.tick({now:time,market:{slug:SLUG,priceIncrement:.005,quantityIncrement:1,minimumTradeQty:1,bookReceivedAt:time},intents,gate,...over});
  const quotes=(yesBid:number,yesAsk:number):LiveIntent[]=>[{side:'YES',price:yesBid,style:'maker',strategy:'maker-quote'},{side:'NO',price:Math.round((1-yesAsk)*1e6)/1e6,style:'maker',strategy:'maker-quote'}];
  return {exchange,executor,arm,tick,quotes,state:()=>saved,saves};
}

test('wire format: YES prices on the wire, post-only resting buys, automated flag',()=>{
  assert.deepEqual(liveOrderRequest({slug:SLUG,side:'NO',price:.39,quantity:12,style:'maker'}),{marketSlug:SLUG,intent:'ORDER_INTENT_BUY_SHORT',type:'ORDER_TYPE_LIMIT',
    price:{value:'0.61',currency:'USD'},quantity:12,tif:'TIME_IN_FORCE_GOOD_TILL_CANCEL',participateDontInitiate:true,manualOrderIndicator:'MANUAL_ORDER_INDICATOR_AUTOMATIC',synchronousExecution:false});
  const taker=liveOrderRequest({slug:SLUG,side:'YES',price:.83,quantity:5,style:'taker'});
  assert.equal(taker.tif,'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');assert.equal(taker.participateDontInitiate,false);assert.equal(taker.price!.value,'0.83');
});

test('arming: disabled runner, limits above the hard caps, a bad preview echo and existing orders all refuse',async()=>{
  await assert.rejects(harness(false).arm(),/LIVE_TRADING_ENABLED/);
  await assert.rejects(harness().arm({limits:{...DEFAULT_LIVE_LIMITS,maxOrderUsd:LIVE_HARD_LIMITS.maxOrderUsd+1}}),/maxOrderUsd/);
  const echo=harness();echo.exchange.previewPrice='0.99';
  await assert.rejects(echo.arm(),/preview did not echo/);
  const busy=harness();busy.exchange.manualOrder(SLUG);
  await assert.rejects(busy.arm(),/already has open orders/);
  const ok=harness();const state=await ok.arm();
  assert.equal(state.armed,true);assert.equal(state.contractValidatedAt,T0);
  assert.ok(!ok.exchange.calls.includes('create'),'arming never places an order');
});

test('pilot quoting: journal before submission, both sides post-only, no duplicates',async()=>{
  const h=harness();await h.arm();
  h.exchange.beforeCreate=()=>{assert.ok(h.state().orders.some(order=>order.status==='submitting'),'the order is journaled before it is sent');};
  await h.tick(T0+1000,h.quotes(.60,.61));
  const created=h.exchange.created;
  assert.equal(created.length,2);
  assert.deepEqual(created.map(order=>[order.intent,order.price!.value,order.quantity,order.participateDontInitiate]),[['ORDER_INTENT_BUY_LONG','0.6',8,true],['ORDER_INTENT_BUY_SHORT','0.61',12,true]]);
  assert.deepEqual(h.state().orders.map(order=>[order.side,order.status,order.evidence]),[['YES','open','cfb-pregame-maker'],['NO','open','cfb-pregame-maker']]);
  await h.tick(T0+3500,h.quotes(.60,.61));
  assert.equal(h.exchange.created.length,2,'the same quotes are not re-sent');
});

test('a moved quote is cancelled, and replaced only after the old order has left the book',async()=>{
  const h=harness();await h.arm();
  await h.tick(T0+1000,h.quotes(.60,.61));
  await h.tick(T0+3500,h.quotes(.62,.63));
  assert.equal(h.exchange.calls.filter(call=>call==='cancel').length,2);
  assert.equal(h.exchange.created.length,2,'no replacement while the old orders may still be live');
  await h.tick(T0+6000,h.quotes(.62,.63));
  assert.equal(h.exchange.created.length,4);
  assert.deepEqual(h.exchange.created.slice(2).map(order=>order.price!.value),['0.62','0.63']);
});

test('fills are reconciled from the exchange, and exposure stays capped',async()=>{
  const h=harness();await h.arm({limits:{...DEFAULT_LIVE_LIMITS,maxOpenExposureUsd:12}});
  await h.tick(T0+1000,h.quotes(.60,.61));
  assert.equal(h.exchange.created.length,2);
  h.exchange.move(.59,.60);
  await h.tick(T0+3500,h.quotes(.59,.60));
  const yes=h.state().orders.find(order=>order.side==='YES'&&order.price===.6)!;
  assert.equal(yes.status,'closed');assert.equal(yes.exchangeState,'ORDER_STATE_FILLED');assert.equal(yes.cumQuantity,8);
  assert.ok(h.state().log.some(row=>row.kind==='fill'));
  assert.equal(h.state().positions[SLUG].netPosition,8);
  // $4.80 of inventory plus the $4.68 NO bid leaves no room for another $4.72 YES bid under a $12 cap.
  assert.equal(h.exchange.created.length,2);assert.match(h.state().lastSkip!,/exposure limit/);
});

test('an unknown submission outcome kills: never retried, everything cancelled, re-arm resolves it',async()=>{
  const h=harness();await h.arm();
  h.exchange.failNextCreate='timeout';
  await h.tick(T0+1000,h.quotes(.60,.61));
  const state=h.state();
  assert.equal(state.armed,false);assert.match(state.halted!,/unknown/);
  assert.equal(h.exchange.created.length,1,'no retry and no second order after the unknown one');
  assert.ok(h.exchange.calls.includes('cancelAll'));
  assert.equal(state.orders[0].status,'unknown');
  await h.tick(T0+3500,h.quotes(.60,.61));
  assert.equal(h.exchange.created.length,1,'a killed executor places nothing');
  const rearmed=await h.arm();
  assert.equal(rearmed.armed,true);assert.equal(rearmed.orders[0].status,'closed');assert.match(rearmed.orders[0].reason,/resolved at arming/);
});

test('kill switches: daily loss, foreign orders, repeated sync failures, stale market data',async()=>{
  const loss=harness();await loss.arm();
  loss.exchange.cash-=DEFAULT_LIVE_LIMITS.maxDailyLossUsd;
  await loss.tick(T0+1000,loss.quotes(.60,.61));
  assert.match(loss.state().halted!,/Daily loss limit/);assert.equal(loss.exchange.created.length,0);
  const foreign=harness();await foreign.arm();
  foreign.exchange.manualOrder(SLUG);
  await foreign.tick(T0+1000,foreign.quotes(.60,.61));
  assert.match(foreign.state().halted!,/did not place/);
  const flaky=harness();await flaky.arm();
  flaky.exchange.failBalances=3;
  for(let i=1;i<=3;i++)await flaky.tick(T0+i*1000,flaky.quotes(.60,.61));
  assert.match(flaky.state().halted!,/could not be synced 3 times/);
  const stale=harness();await stale.arm();
  await stale.tick(T0+1000,stale.quotes(.60,.61));
  await stale.tick(T0+20_000,stale.quotes(.60,.61),{market:{slug:SLUG,priceIncrement:.005,quantityIncrement:1,minimumTradeQty:1,bookReceivedAt:T0+10_000}});
  assert.equal(stale.exchange.calls.filter(call=>call==='cancel').length,2,'resting orders are cancelled when the book is stale');
  assert.equal(stale.state().armed,true);
});

test('the evidence gate is re-checked live, and taker entries need PROVEN evidence',async()=>{
  const h=harness();await h.arm();
  const refuse=(intent:LiveIntent)=>decide({sport:'NFL',phase:'live',style:intent.style==='maker'?'maker':'taker-hold',mode:'pilot',ask:.61,bid:.60});
  await h.tick(T0+1000,h.quotes(.60,.61),{gate:refuse});
  assert.equal(h.exchange.created.length,0);assert.match(h.state().lastSkip!,/DROPPED/);
  const logged=h.state().log.length;
  await h.tick(T0+3500,h.quotes(.60,.61),{gate:refuse});
  assert.equal(h.state().log.length,logged,'the same refusal is logged once, not every tick');
  await h.tick(T0+6000,[{side:'YES',price:.61,style:'taker',strategy:'favourite-hold',commandId:'paper-intent-1'}]);
  assert.equal(h.exchange.created.length,0,'a LEAD is never enough for a real-money taker entry');
});

test('rejections are recorded without killing; disarm cancels resting orders',async()=>{
  const h=harness();await h.arm();
  h.exchange.failNextCreate='reject';
  await h.tick(T0+1000,h.quotes(.60,.61));
  assert.equal(h.state().armed,true);
  assert.deepEqual(h.state().orders.map(order=>order.status),['rejected','open']);
  // A post-only quote that would cross is rejected by the exchange, not filled as a taker.
  h.exchange.move(.60,.605);
  await h.tick(T0+3500,[{side:'YES',price:.605,style:'maker',strategy:'maker-quote'}]);
  assert.ok(h.state().orders.some(order=>order.status==='rejected'&&/cross/.test(order.reason)));
  const state=await h.executor.disarm(T0+5000);
  assert.equal(state.armed,false);assert.equal(state.halted,null);
  assert.equal(await h.exchange.openOrders([SLUG]).then(r=>r.orders.length),0);
});
