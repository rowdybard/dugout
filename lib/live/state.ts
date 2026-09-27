import type {CreateOrderParams,GetAccountBalancesResponse,GetUserPositionsResponse,Order,OrderState} from 'polymarket-us';

/**
 * Real-money account state for the owner's runner. Pure data and rules; network I/O lives in executor.ts.
 * Everything here is conservative: when a fact is unknown, new orders stop.
 */

/** Hard ceilings in code. The owner may choose lower limits when arming, never higher. */
export const LIVE_HARD_LIMITS=Object.freeze({maxOrderUsd:25,maxOpenExposureUsd:100,maxDailyLossUsd:50,maxOrdersPerDay:500,maxDataAgeMs:5000});
export const DEFAULT_LIVE_LIMITS=Object.freeze({maxOrderUsd:5,maxOpenExposureUsd:25,maxDailyLossUsd:10,maxOrdersPerDay:200,maxDataAgeMs:5000});
export type LiveLimits={maxOrderUsd:number;maxOpenExposureUsd:number;maxDailyLossUsd:number;maxOrdersPerDay:number;maxDataAgeMs:number};
/** Consecutive failed account syncs tolerated before the kill switch fires. */
export const MAX_SYNC_FAILURES=3;
/** An armed account whose last good sync is older than this stops trading. */
export const MAX_SYNC_AGE_MS=30_000;

export type LiveOrder={
  /** Our id, written to storage before any network call. */
  commandId:string;orderId:string|null;
  slug:string;side:'YES'|'NO';action:'BUY';style:'maker'|'taker';
  /** Price of the outcome bought (the NO price for NO); the wire price is always the YES price. */
  price:number;quantity:number;
  status:'submitting'|'open'|'unknown'|'closed'|'rejected';
  exchangeState?:OrderState;cumQuantity:number;leavesQuantity:number;
  createdAt:number;updatedAt:number;reason:string;
  strategy:string;evidence:string|null;pack:string;
  request:CreateOrderParams;
};
export type LivePosition={slug:string;netPosition:number;cost:number;realized:number;cashValue:number|null;updatedAt:number};
export type LiveLogRow={time:number;kind:'arm'|'disarm'|'kill'|'order'|'cancel'|'fill'|'sync'|'error';message:string};
export type LiveState={
  version:1;
  armed:boolean;mode:'pilot'|'real';focusSlug:string|null;limits:LiveLimits;
  armedAt:number|null;contractValidatedAt:number|null;
  /** Any reason stops new orders; clearing it requires re-arming (which re-validates the account). */
  halted:string|null;
  orders:LiveOrder[];
  balance:{cash:number;buyingPower:number;assetNotional:number|null;updatedAt:number}|null;
  positions:Record<string,LivePosition>;
  day:{date:string;startEquity:number|null;orders:number};
  equity:number|null;
  lastSyncAt:number|null;syncFailures:number;lastError:string|null;
  /** Last reason an intent was not placed, logged only when it changes. */
  lastSkip:string|null;
  log:LiveLogRow[];
};

export function emptyLiveState():LiveState {
  return {version:1,armed:false,mode:'pilot',focusSlug:null,limits:{...DEFAULT_LIVE_LIMITS},armedAt:null,contractValidatedAt:null,halted:null,
    orders:[],balance:null,positions:{},day:{date:'',startEquity:null,orders:0},equity:null,lastSyncAt:null,syncFailures:0,lastError:null,lastSkip:null,log:[]};
}

export function limitsIssue(limits:LiveLimits):string|null {
  for(const [key,max] of Object.entries(LIVE_HARD_LIMITS) as [keyof LiveLimits,number][]){
    const value=limits[key];
    if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>max)return `${key} must be above 0 and at most ${max}.`;
  }
  return null;
}

export function logEvent(state:LiveState,time:number,kind:LiveLogRow['kind'],message:string) {
  state.log=[...state.log,{time,kind,message}].slice(-200);
}

const num=(value:unknown)=>{const parsed=typeof value==='number'?value:typeof value==='string'?Number(value):NaN;return Number.isFinite(parsed)?parsed:null;};
const amount=(value:{value?:unknown}|undefined|null)=>num(value?.value);
const dayOf=(time:number)=>new Date(time).toISOString().slice(0,10);
export const liveOpen=(order:LiveOrder)=>order.status==='open'||order.status==='submitting'||order.status==='unknown';

/**
 * Apply one account snapshot: USD balance, positions, and the exchange's open orders for the focus market.
 * Returns the ids of our orders that are no longer open, so the executor can fetch their final state.
 */
export function applySnapshot(state:LiveState,snapshot:{balances:GetAccountBalancesResponse;positions:GetUserPositionsResponse;open:Order[]},now:number):{gone:LiveOrder[];foreign:Order[]} {
  const usd=(snapshot.balances.balances??[]).find(balance=>balance.currency==='USD');
  const cash=num(usd?.currentBalance),buyingPower=num(usd?.buyingPower);
  if(cash===null||buyingPower===null)throw new Error('The account balance response has no USD balance.');
  state.balance={cash,buyingPower,assetNotional:num(usd?.assetNotional),updatedAt:now};
  const positions:Record<string,LivePosition>={};
  for(const [key,position] of Object.entries(snapshot.positions.positions??{})){
    const slug=position.marketMetadata?.slug??key,net=num(position.netPosition);
    if(net===null)throw new Error(`Position ${slug} has no numeric net position.`);
    positions[slug]={slug,netPosition:net,cost:amount(position.cost)??0,realized:amount(position.realized)??0,cashValue:amount(position.cashValue),updatedAt:now};
  }
  state.positions=positions;
  const marks=Object.values(positions).map(position=>position.netPosition===0?0:position.cashValue);
  state.equity=marks.some(mark=>mark===null)?null:cash+marks.reduce<number>((sum,mark)=>sum+(mark??0),0);
  const date=dayOf(now);
  if(state.day.date!==date)state.day={date,startEquity:state.equity,orders:0};
  else if(state.day.startEquity===null)state.day.startEquity=state.equity;
  const byId=new Map(snapshot.open.map(order=>[order.id,order]));
  const gone:LiveOrder[]=[];
  for(const order of state.orders){
    if(order.status!=='open'||!order.orderId)continue;
    const current=byId.get(order.orderId);
    if(!current){gone.push(order);continue;}
    order.exchangeState=current.state;order.cumQuantity=current.cumQuantity;order.leavesQuantity=current.leavesQuantity;order.updatedAt=now;
  }
  const ours=new Set(state.orders.map(order=>order.orderId).filter(Boolean));
  const foreign=snapshot.open.filter(order=>!ours.has(order.id));
  state.lastSyncAt=now;state.syncFailures=0;state.lastError=null;
  return {gone,foreign};
}

/** Final state of an order that left the open list (filled, cancelled, expired or rejected by the exchange). */
export function closeOrder(state:LiveState,order:LiveOrder,final:Order|null,now:number) {
  order.status='closed';order.updatedAt=now;
  if(final){order.exchangeState=final.state;order.cumQuantity=final.cumQuantity;order.leavesQuantity=final.leavesQuantity;}
  const filled=order.cumQuantity;
  if(filled>0)logEvent(state,now,'fill',`${order.side} ${filled} of ${order.quantity} at ${(order.price*100).toFixed(1)}¢ filled (${order.exchangeState??'final state unknown'}).`);
  // Keep every open/unknown record and the latest 200 finished ones.
  const finished=state.orders.filter(item=>!liveOpen(item));
  if(finished.length>200){const drop=new Set(finished.slice(0,finished.length-200));state.orders=state.orders.filter(item=>!drop.has(item));}
}

/** Open exposure: position cost plus the notional of our resting buys. */
export function openExposure(state:LiveState):number {
  const positions=Object.values(state.positions).reduce((sum,position)=>sum+Math.abs(position.cost),0);
  const resting=state.orders.filter(liveOpen).reduce((sum,order)=>sum+order.price*(order.status==='open'?order.leavesQuantity||order.quantity:order.quantity),0);
  return positions+resting;
}

/** The kill-switch rules. Any non-null reason cancels every order and halts until the owner re-arms. */
export function killReason(state:LiveState,now:number):string|null {
  // A 'submitting' record at the start of a tick means a crash between journaling and the exchange's answer.
  if(state.orders.some(order=>order.status==='unknown'||order.status==='submitting'))return 'An order submission has an unknown outcome. Orders are cancelled until the account is re-armed and re-checked.';
  if(state.syncFailures>=MAX_SYNC_FAILURES)return `The account could not be synced ${state.syncFailures} times in a row.`;
  if(state.lastSyncAt===null||now-state.lastSyncAt>MAX_SYNC_AGE_MS)return 'The account state is stale.';
  if(state.equity!==null&&state.day.startEquity!==null&&state.day.startEquity-state.equity>=state.limits.maxDailyLossUsd)
    return `Daily loss limit reached: down $${(state.day.startEquity-state.equity).toFixed(2)} (limit $${state.limits.maxDailyLossUsd}).`;
  if(openExposure(state)>state.limits.maxOpenExposureUsd+1e-9)return `Open exposure $${openExposure(state).toFixed(2)} is above the $${state.limits.maxOpenExposureUsd} limit.`;
  return null;
}
