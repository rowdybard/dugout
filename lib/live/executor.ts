import type {CreateOrderParams,Order} from 'polymarket-us';
import {LiveApiError,type LiveExchange} from './client.ts';
import {applySnapshot,closeOrder,killReason,limitsIssue,liveOpen,logEvent,openExposure,type LiveLimits,type LiveOrder,type LiveState} from './state.ts';
import type {Verdict} from '../decision/engine.ts';

/**
 * Real-money executor for the owner's runner. It only mirrors decisions the paper bot already made under the
 * evidence gate (resting quotes; taker entries only if evidence is PROVEN), re-checks each one in live mode, and
 * enforces the account's own limits. Orders are journaled before submission and never retried.
 */

export type LiveStore={load():LiveState;save(state:LiveState):void|Promise<void>};
export type LiveMarket={slug:string;priceIncrement:number;quantityIncrement:number;minimumTradeQty:number;bookReceivedAt:number};
/** A decision to mirror. Maker quotes rest (post-only GTC); taker entries are one-shot IOC keyed by commandId. */
export type LiveIntent={side:'YES'|'NO';price:number;style:'maker'|'taker';strategy:string;commandId?:string};
export type LiveTick={
  now:number;
  /** The focus market's execution rules and book time; null when there is no fresh book. */
  market:LiveMarket|null;
  intents:LiveIntent[];
  /** Independent evidence check in the live mode (pilot or real). */
  gate:(intent:LiveIntent)=>Verdict;
};
export type ArmRequest={mode:'pilot'|'real';focusSlug:string;limits:LiveLimits;priceIncrement:number;minimumTradeQty:number};

const EPSILON=1e-9;
const aligned=(value:number,step:number)=>step>0&&Math.abs(value/step-Math.round(value/step))<1e-7;
const floorTo=(value:number,step:number)=>Math.floor(value/step+1e-9)*step;
const decimal=(value:number)=>Number(value.toFixed(8)).toString();

/** Wire format: the price is ALWAYS the YES price (docs.polymarket.us orders overview), including NO purchases. */
export function liveOrderRequest(order:{slug:string;side:'YES'|'NO';price:number;quantity:number;style:'maker'|'taker'}):CreateOrderParams {
  const yesPrice=order.side==='YES'?order.price:1-order.price;
  return {marketSlug:order.slug,intent:order.side==='YES'?'ORDER_INTENT_BUY_LONG':'ORDER_INTENT_BUY_SHORT',type:'ORDER_TYPE_LIMIT',
    price:{value:decimal(yesPrice),currency:'USD'},quantity:order.quantity,
    tif:order.style==='maker'?'TIME_IN_FORCE_GOOD_TILL_CANCEL':'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    participateDontInitiate:order.style==='maker',manualOrderIndicator:'MANUAL_ORDER_INDICATOR_AUTOMATIC',synchronousExecution:false};
}

export function createLiveExecutor(deps:{exchange:LiveExchange;store:LiveStore;enabled:boolean;id?:()=>string}) {
  const {exchange,store}=deps;
  const newId=deps.id??(()=>crypto.randomUUID());
  const message=(error:unknown)=>error instanceof Error?error.message:'Unknown error';

  async function cancelFocus(state:LiveState,now:number,reason:string) {
    if(!state.focusSlug)return;
    try{const result=await exchange.cancelAll([state.focusSlug]);logEvent(state,now,'cancel',`Cancelled ${result.canceledOrderIds?.length??0} order(s): ${reason}`);}
    catch(error){logEvent(state,now,'error',`Cancel-all failed (${message(error)}); orders will be re-checked on the next sync.`);}
  }

  async function kill(state:LiveState,now:number,reason:string) {
    state.halted=reason;state.armed=false;
    logEvent(state,now,'kill',reason);
    await store.save(state);
    await cancelFocus(state,now,reason);
    await store.save(state);
  }

  async function sync(state:LiveState,now:number):Promise<Order[]|null> {
    if(!state.focusSlug)return null;
    try{
      const [balances,positions,open]=await Promise.all([exchange.balances(),exchange.positions(state.focusSlug),exchange.openOrders([state.focusSlug])]);
      const {gone,foreign}=applySnapshot(state,{balances,positions,open:open.orders??[]},now);
      for(const order of gone){
        // A missing open order was filled, cancelled or expired; fetch its final state when possible.
        let final:Order|null=null;
        try{final=(await exchange.order(order.orderId!)).order??null;}catch{final=null;}
        closeOrder(state,order,final,now);
      }
      return foreign;
    }catch(error){
      state.syncFailures++;state.lastError=message(error);
      logEvent(state,now,'error',`Account sync failed (${state.syncFailures}): ${state.lastError}`);
      return null;
    }
  }

  // Reasons an intent was not placed this tick; logged only when the set changes, not every 2.5 s.
  let skips:string[]=[];
  function skip(_state:LiveState,_now:number,reason:string) {skips.push(reason);}
  function flushSkips(state:LiveState,now:number) {
    const text=skips.join(' | ');skips=[];
    if(text&&text!==state.lastSkip)logEvent(state,now,'order',`Not placed: ${text}`);
    state.lastSkip=text||null;
  }

  async function place(state:LiveState,tick:LiveTick,intent:LiveIntent,verdict:Verdict):Promise<void> {
    const market=tick.market!,slug=state.focusSlug!;
    const quantity=Number(floorTo(state.limits.maxOrderUsd/intent.price,market.quantityIncrement).toFixed(8));
    if(quantity<market.minimumTradeQty-EPSILON)return skip(state,tick.now,`${intent.side}: $${state.limits.maxOrderUsd} buys less than the ${market.minimumTradeQty}-contract minimum.`);
    if(openExposure(state)+quantity*intent.price>state.limits.maxOpenExposureUsd+EPSILON)return skip(state,tick.now,`${intent.side}: another order would exceed the $${state.limits.maxOpenExposureUsd} exposure limit.`);
    if(state.day.orders>=state.limits.maxOrdersPerDay){await kill(state,tick.now,`Daily order limit (${state.limits.maxOrdersPerDay}) reached.`);return;}
    const yesPrice=intent.side==='YES'?intent.price:1-intent.price;
    if(!aligned(yesPrice,market.priceIncrement))return skip(state,tick.now,`${intent.side} at ${intent.price}: not on the ${market.priceIncrement} tick.`);
    const request=liveOrderRequest({slug,side:intent.side,price:intent.price,quantity,style:intent.style});
    const order:LiveOrder={commandId:intent.commandId??newId(),orderId:null,slug,side:intent.side,action:'BUY',style:intent.style,price:intent.price,quantity,
      status:'submitting',cumQuantity:0,leavesQuantity:quantity,createdAt:tick.now,updatedAt:tick.now,reason:verdict.reason.slice(0,300),
      strategy:intent.strategy,evidence:verdict.deciding?.id??null,pack:verdict.pack,request};
    state.orders.push(order);state.day.orders++;
    // Journal first: a crash after this line leaves a 'submitting' record, which blocks re-sending.
    await store.save(state);
    try{
      const response=await exchange.createOrder(request);
      if(typeof response?.id!=='string'||!response.id)throw new LiveApiError(200,'The exchange acknowledged without an order id.',true);
      order.orderId=response.id;order.status='open';order.updatedAt=tick.now;
      logEvent(state,tick.now,'order',`${intent.style==='maker'?'Resting':'IOC'} buy ${intent.side} ${quantity} at ${(intent.price*100).toFixed(1)}¢ (${verdict.code}).`);
    }catch(error){
      if(error instanceof LiveApiError&&!error.outcomeUnknown){
        order.status='rejected';order.reason=error.message.slice(0,300);order.leavesQuantity=0;
        logEvent(state,tick.now,'order',`Rejected: ${error.message}`);
      }else{
        order.status='unknown';order.reason=message(error).slice(0,300);
        await kill(state,tick.now,`Order submission outcome unknown (${message(error)}). Never retried; all orders cancelled.`);
        return;
      }
    }
    await store.save(state);
  }

  return {
    /** Read-only contract checks, then arm. Nothing is ordered here. */
    async arm(request:ArmRequest,now:number):Promise<LiveState> {
      const state=store.load();
      if(!deps.enabled)throw new Error('Live trading is disabled on this runner (set LIVE_TRADING_ENABLED=true to allow arming).');
      const issue=limitsIssue(request.limits);
      if(issue)throw new Error(issue);
      if(!/^aec-[a-z]+-[a-z0-9-]+$/.test(request.focusSlug))throw new Error('Choose a full-game winner market to arm.');
      const unresolved=state.orders.filter(liveOpen);
      if(unresolved.length){
        // Earlier records (including unknown submissions) resolve only when the exchange shows nothing open on
        // their markets; any fill they had is already in the account's positions.
        const slugs=[...new Set(unresolved.map(order=>order.slug))];
        const still=(await exchange.openOrders(slugs)).orders??[];
        if(still.length)throw new Error(`${still.length} order(s) are still open on the exchange. Press Kill (cancels them), then arm again.`);
        for(const order of unresolved){
          let final:Order|null=null;
          if(order.orderId)try{final=(await exchange.order(order.orderId)).order??null;}catch{final=null;}
          order.reason=`${order.status==='open'?'':`Was ${order.status}; `}resolved at arming: nothing open on the exchange.`;
          closeOrder(state,order,final,now);
        }
      }
      const [balances,positions,open]=await Promise.all([exchange.balances(),exchange.positions(request.focusSlug),exchange.openOrders([request.focusSlug])]);
      const probe:LiveState={...state,focusSlug:request.focusSlug,orders:[]};
      applySnapshot(probe,{balances,positions,open:open.orders??[]},now);
      if((open.orders??[]).length)throw new Error('This market already has open orders on the account. Cancel them before arming.');
      // Contract probe: preview (never place) a far post-only buy and check the exchange echoes our wire format.
      const price=Math.max(0.01,request.priceIncrement);
      const preview=await exchange.previewOrder(liveOrderRequest({slug:request.focusSlug,side:'YES',price,quantity:request.minimumTradeQty,style:'maker'}));
      const echoed=preview?.order;
      if(!echoed||echoed.marketSlug!==request.focusSlug||echoed.intent!=='ORDER_INTENT_BUY_LONG'||Math.abs(Number(echoed.price?.value)-price)>EPSILON)
        throw new Error('The order preview did not echo the expected market, intent and price. Not arming.');
      Object.assign(state,{armed:true,mode:request.mode,focusSlug:request.focusSlug,limits:{...request.limits},armedAt:now,contractValidatedAt:now,halted:null,
        balance:probe.balance,positions:probe.positions,equity:probe.equity,day:probe.day,lastSyncAt:now,syncFailures:0,lastError:null});
      logEvent(state,now,'arm',`Armed (${request.mode}) on ${request.focusSlug}: max order $${request.limits.maxOrderUsd}, exposure $${request.limits.maxOpenExposureUsd}, daily loss $${request.limits.maxDailyLossUsd}.`);
      await store.save(state);
      return state;
    },

    async disarm(now:number,reason='Disarmed by the owner.'):Promise<LiveState> {
      const state=store.load();
      state.armed=false;logEvent(state,now,'disarm',reason);
      await store.save(state);
      await cancelFocus(state,now,reason);
      await store.save(state);
      return state;
    },

    async kill(now:number,reason='Kill switch pressed by the owner.'):Promise<LiveState> {
      const state=store.load();
      await kill(state,now,reason);
      return state;
    },

    /** One runner tick: sync, kill-switch rules, cancel what is no longer wanted, place what is missing. */
    async tick(tick:LiveTick):Promise<LiveState> {
      const state=store.load();
      if(!state.armed||!state.focusSlug)return state;
      const now=tick.now;
      skips=[];
      const foreign=await sync(state,now);
      const reason=killReason(state,now)??(foreign&&foreign.length?'Orders the bot did not place are open on this market.':null);
      if(reason){await kill(state,now,reason);return state;}
      if(foreign===null){await store.save(state);return state;}
      const fresh=!!tick.market&&tick.market.slug===state.focusSlug&&now-tick.market.bookReceivedAt<=state.limits.maxDataAgeMs&&tick.market.bookReceivedAt<=now;
      const wanted=fresh?tick.intents:[];
      const open=state.orders.filter(order=>order.slug===state.focusSlug&&order.status==='open');
      // Cancel resting orders that are no longer the paper bot's quote at the same price.
      for(const order of open.filter(order=>order.style==='maker')){
        const keep=wanted.some(intent=>intent.style==='maker'&&intent.side===order.side&&Math.abs(intent.price-order.price)<EPSILON);
        if(keep||order.reason.startsWith('Cancel requested'))continue;
        try{await exchange.cancelOrder(order.orderId!,order.slug);order.reason=`Cancel requested at ${new Date(now).toISOString()}.`;logEvent(state,now,'cancel',`Cancel ${order.side} at ${(order.price*100).toFixed(1)}¢.`);}
        catch(error){logEvent(state,now,'error',`Cancel failed (${message(error)}); re-checked on the next sync.`);}
      }
      for(const intent of wanted){
        // One live order per side; a replacement waits until the old one has left the book.
        if(state.orders.some(order=>order.slug===state.focusSlug&&liveOpen(order)&&order.side===intent.side))continue;
        if(intent.commandId&&state.orders.some(order=>order.commandId===intent.commandId))continue;
        const verdict=tick.gate(intent);
        if(!verdict.permitted||(intent.style==='taker'&&verdict.code!=='PROVEN')){skip(state,now,`${intent.side} ${intent.style}: ${verdict.code}. ${verdict.reason.slice(0,200)}`);continue;}
        await place(state,tick,intent,verdict);
        if(!state.armed)return state;
      }
      flushSkips(state,now);
      await store.save(state);
      return state;
    },
  };
}

export type LiveExecutor=ReturnType<typeof createLiveExecutor>;
