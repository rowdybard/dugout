import type {SideKey} from './context.ts';
import type {ExitRule} from './spec.ts';
import {takerFee} from './costs.ts';

/**
 * Shadow and counterfactual evaluation (docs/STRATEGY-ARCHITECTURE.md#counterfactuals). Pure and deterministic.
 *
 * - candidate: a would-be trade from a strategy that may not trade yet. It is measured forward from the books Dugout
 *   actually saw, with the spec's primary exit, but never touches the paper account.
 * - executed: attached to a real paper trade, measuring what alternative decisions would have returned.
 *
 * Every trade carries legs (the actual entry; entering 15 or 30 s later; the opposite side; a resting order instead of
 * a taker fill) and, per leg, exit policies (the spec's primary exit, its alternatives, and a standard set: hold,
 * targets, stops, time limits, a trailing exit, the drive's end). Counterfactual results are hypothesis-generation
 * data for FUTURE versions. They never change the running version's behaviour or its scorecard sample.
 */

/** Policy state per leg. Its rules live once on the trade (`exits`), keyed by id, to keep stored sessions small. */
export type ShadowPolicy={id:string;status:'open'|'closed';exitTime?:number;exitPrice?:number;ret?:number;why?:string;peak?:number};
export type ShadowLeg={
  id:'base'|'delay-15s'|'delay-30s'|'opposite'|'maker';side:SideKey;mode:'taker'|'maker';
  /** Taker legs enter on the first executable book at or after this time; maker legs rest from it. */
  entryAfter:number;
  /** Maker legs: the resting price, and when the order is withdrawn unfilled. */
  restPrice?:number;restUntil?:number;
  entry:{time:number;price:number;fee:number;mid:number}|null;
  status:'waiting'|'open'|'closed'|'missed';
  policies:ShadowPolicy[];
};
export type ShadowTrade={
  id:string;kind:'executed'|'candidate';strategy:string;version:string;slug:string;sport:string;setupKey?:string;
  createdAt:number;primary:string;maxSpread:number;
  /** Every exit policy used by any leg, by id. */
  exits:{id:string;rules:ExitRule[]}[];
  /** Buckets for the scorecard, fixed at creation. */
  context:{priceBucket:string;liquidity:'thin'|'normal'|'deep'|'unknown';state:string;spread:number;fair?:number|null};
  /** Retrace exits: the side's midpoint before the event it is fading. */
  preEventSideMid?:number|null;
  legs:ShadowLeg[];
  /** Base leg, primary policy: worst and best net return seen while open. */
  mae:number;mfe:number;
  done:boolean;settlement?:number|null;closedAt?:number;
};
export type ShadowObservation={time:number;yesBid:number|null;yesAsk:number|null;
  /** Football: the drive the trade was entered on has ended / possession has changed since entry. */
  driveEnded?:boolean;possessionChanged?:boolean};

export const MAKER_REBATE_COEFFICIENT=0.0125;
const DELAY_WINDOW_MS=30_000,MAKER_REST_MS=60_000;
const round=(x:number)=>Math.round(x*1e6)/1e6;
const bucket=(price:number)=>{const lo=Math.min(9,Math.floor(price*10));return `${(lo/10).toFixed(1)}–${((lo+1)/10).toFixed(1)}`;};

/**
 * The standard counterfactual exits every taker trade is measured under, besides its spec's own. Price exits are
 * capped at 30 minutes ("+5% within 30 min, else sell"), so in-game counterfactuals finish during the game and the
 * shadow can be compacted while only the final result is pending.
 */
const CAP:ExitRule={kind:'time',ms:1_800_000};
export const STANDARD_EXITS:readonly {id:string;rules:ExitRule[]}[]=Object.freeze([
  {id:'hold',rules:[{kind:'settlement'}]},
  {id:'target-5',rules:[{kind:'target',netReturn:0.05},CAP]},{id:'target-10',rules:[{kind:'target',netReturn:0.1},CAP]},{id:'target-20',rules:[{kind:'target',netReturn:0.2},CAP]},
  {id:'stop-10',rules:[{kind:'stop',netReturn:0.1},CAP]},{id:'stop-20',rules:[{kind:'stop',netReturn:0.2},CAP]},
  {id:'time-2m',rules:[{kind:'time',ms:120_000}]},{id:'time-5m',rules:[{kind:'time',ms:300_000}]},{id:'time-12m',rules:[{kind:'time',ms:720_000}]},
  {id:'trailing-10',rules:[{kind:'trailing',drawdown:0.1},CAP]},
]);
export const FOOTBALL_EXITS:readonly {id:string;rules:ExitRule[]}[]=Object.freeze([
  {id:'drive-end',rules:[{kind:'drive-end'},CAP]},{id:'possession-change',rules:[{kind:'possession-change'},CAP]},
]);

const sideBook=(obs:{yesBid:number|null;yesAsk:number|null},side:SideKey)=>side==='yes'?{bid:obs.yesBid,ask:obs.yesAsk}:
  {bid:obs.yesAsk===null?null:round(1-obs.yesAsk),ask:obs.yesBid===null?null:round(1-obs.yesBid)};

export function openShadow(input:{
  id:string;kind:'executed'|'candidate';strategy:string;version:string;slug:string;sport:string;setupKey?:string;
  side:SideKey;mode:'taker'|'maker';time:number;yesBid:number;yesAsk:number;maxSpread:number;
  primary:ExitRule[];alternatives:{id:string;rules:ExitRule[]}[];football:boolean;
  askDepth2c?:number|null;state:string;fair?:number|null;preEventSideMid?:number|null;restMs?:number;
  /** Executed trades: the actual fill (the base leg uses it instead of the signal book). */
  fill?:{time:number;price:number;fee:number};
}):ShadowTrade {
  const book=sideBook(input,input.side),price=input.mode==='maker'?book.bid!:book.ask!;
  const exits=input.mode==='maker'?[{id:'primary',rules:input.primary},...input.alternatives,{id:'hold',rules:[{kind:'settlement'} as ExitRule]}]:
    [{id:'primary',rules:input.primary},...input.alternatives,...STANDARD_EXITS,...(input.football?FOOTBALL_EXITS:[])];
  const unique=[...new Map(exits.map(exit=>[exit.id,exit])).values()];
  const policies=(ids?:string[])=>unique.filter(exit=>!ids||ids.includes(exit.id)).map(exit=>({id:exit.id,status:'open' as const}));
  const leg=(id:ShadowLeg['id'],side:SideKey,mode:'taker'|'maker',entryAfter:number,ids?:string[],rest?:{price:number;until:number}):ShadowLeg=>
    ({id,side,mode,entryAfter,...(rest?{restPrice:rest.price,restUntil:rest.until}:{}),entry:null,status:'waiting',policies:policies(ids)});
  const small=['primary','hold'];
  const legs:ShadowLeg[]=input.mode==='maker'?
    [leg('base',input.side,'maker',input.time+1000,undefined,{price,until:input.time+(input.restMs??MAKER_REST_MS)})]:
    [leg('base',input.side,'taker',input.time),leg('delay-15s',input.side,'taker',input.time+15_000,small),leg('delay-30s',input.side,'taker',input.time+30_000,small),
      leg('opposite',input.side==='yes'?'no':'yes','taker',input.time,small),
      leg('maker',input.side,'maker',input.time+1000,small,{price:book.bid!,until:input.time+MAKER_REST_MS})];
  const depth=input.askDepth2c;
  const trade:ShadowTrade={id:input.id,kind:input.kind,strategy:input.strategy,version:input.version,slug:input.slug,sport:input.sport,
    ...(input.setupKey?{setupKey:input.setupKey}:{}),createdAt:input.time,primary:'primary',maxSpread:input.maxSpread,exits:unique,
    context:{priceBucket:bucket(price),liquidity:depth==null?'unknown':depth<200?'thin':depth<1000?'normal':'deep',state:input.state,
      spread:round(book.ask!-book.bid!),fair:input.fair??null},
    ...(input.preEventSideMid!=null?{preEventSideMid:input.preEventSideMid}:{}),legs,mae:0,mfe:0,done:false};
  if(input.fill){
    const base=trade.legs[0];
    base.entry={...input.fill,mid:round((book.ask!+book.bid!)/2)};base.status='open';
  }
  return advanceShadow(trade,{time:input.time,yesBid:input.yesBid,yesAsk:input.yesAsk},'SIGNAL');
}

const rulesOf=(trade:ShadowTrade,id:string)=>trade.exits.find(exit=>exit.id===id)?.rules??[];

/** Net return per dollar of selling now at `bid` (exit fee paid), for a leg entered at cost price+fee. */
function saleReturn(leg:ShadowLeg,bid:number,coefficient:number){
  const cost=leg.entry!.price+leg.entry!.fee;
  return (bid-takerFee(bid,coefficient))/cost-1;
}

function closePolicy(policy:ShadowPolicy,time:number,price:number,ret:number,why:string){
  Object.assign(policy,{status:'closed',exitTime:time,exitPrice:round(price),ret:round(ret),why});
}

/**
 * Advance every open leg and policy with one observed book. `feeCoefficient` defaults to the research fallback.
 * The `SIGNAL` tag marks the creating observation: taker legs due now fill on it.
 */
export function advanceShadow(trade:ShadowTrade,obs:ShadowObservation,tag:'SIGNAL'|'BOOK'='BOOK',feeCoefficient=0.0695):ShadowTrade {
  if(trade.done)return trade;
  for(const leg of trade.legs){
    const book=sideBook(obs,leg.side);
    if(leg.status==='waiting'){
      if(leg.mode==='taker'){
        const executable=book.ask!==null&&book.bid!==null&&book.ask-book.bid<=trade.maxSpread+1e-9;
        if(obs.time>=leg.entryAfter&&executable)leg.entry={time:obs.time,price:book.ask!,fee:round(takerFee(book.ask!,feeCoefficient)),mid:round((book.ask!+book.bid!)/2)};
        else if(obs.time>leg.entryAfter+DELAY_WINDOW_MS)leg.status='missed';
      }else if(obs.time>=leg.entryAfter&&tag==='BOOK'){
        // Conservative maker fill: this side's ask traded down to our resting price.
        if(book.ask!==null&&book.ask<=leg.restPrice!+1e-9)
          leg.entry={time:obs.time,price:leg.restPrice!,fee:round(-MAKER_REBATE_COEFFICIENT*leg.restPrice!*(1-leg.restPrice!)),mid:round(book.bid!==null?(book.ask+book.bid)/2:book.ask)};
        else if(obs.time>leg.restUntil!)leg.status='missed';
      }
      if(leg.entry)leg.status='open';
      if(leg.status!=='open')continue;
      if(leg.entry!.time===obs.time&&tag==='SIGNAL')continue;
    }
    if(leg.status!=='open')continue;
    const bid=book.bid,mid=book.bid!==null&&book.ask!==null?(book.bid+book.ask)/2:null;
    const now=bid!==null?saleReturn(leg,bid,feeCoefficient):null;
    for(const policy of leg.policies){
      if(policy.status!=='open')continue;
      if(now!==null)policy.peak=round(Math.max(policy.peak??now,now));
      for(const rule of rulesOf(trade,policy.id)){
        const held=obs.time-leg.entry!.time;
        if(rule.kind==='markout'){
          if(held>=rule.ms&&mid!==null){closePolicy(policy,obs.time,mid,(mid-leg.entry!.price-leg.entry!.fee)/leg.entry!.price,'markout');}
          break;
        }
        if(bid===null||now===null)break;
        const hit=rule.kind==='time'?held>=rule.ms:rule.kind==='target'?now>=rule.netReturn-1e-9:rule.kind==='stop'?now<=-rule.netReturn+1e-9:
          rule.kind==='trailing'?(policy.peak??0)>0&&now<=(policy.peak??0)-rule.drawdown+1e-9:
          rule.kind==='drive-end'?!!obs.driveEnded:rule.kind==='possession-change'?!!obs.possessionChanged:
          rule.kind==='retrace'?(trade.preEventSideMid!=null&&mid!==null&&mid>=leg.entry!.mid+rule.fraction*(trade.preEventSideMid-leg.entry!.mid)-1e-9):false;
        if(hit){closePolicy(policy,obs.time,bid,now,rule.kind);break;}
      }
    }
    if(leg.id==='base'){
      const primary=leg.policies.find(policy=>policy.id==='primary');
      if(primary?.status==='open'&&now!==null){trade.mae=round(Math.min(trade.mae,now));trade.mfe=round(Math.max(trade.mfe,now));}
    }
    if(leg.policies.every(policy=>policy.status==='closed'))leg.status='closed';
  }
  return trade;
}

/** The final result: every open policy settles at the YES settlement value (1 or 0). No exit fee at settlement. */
export function settleShadow(trade:ShadowTrade,yesSettlement:number,time:number):ShadowTrade {
  if(trade.done)return trade;
  for(const leg of trade.legs){
    if(leg.status==='waiting')leg.status='missed';
    if(!leg.entry)continue;
    const value=leg.side==='yes'?yesSettlement:1-yesSettlement;
    for(const policy of leg.policies)if(policy.status==='open'){
      const markout=rulesOf(trade,policy.id).some(rule=>rule.kind==='markout');
      closePolicy(policy,time,value,markout?(value-leg.entry.price-leg.entry.fee)/leg.entry.price:(value-leg.entry.price-leg.entry.fee)/(leg.entry.price+leg.entry.fee),'settlement');
    }
    leg.status='closed';
  }
  trade.done=true;trade.settlement=yesSettlement;trade.closedAt=time;
  return trade;
}

/** The trade's own result: base leg, primary policy. Null until it closes (or if it never filled). */
export function primaryResult(trade:ShadowTrade):{ret:number;exitTime:number;entry:number;entryTime:number;why:string}|null {
  const base=trade.legs.find(leg=>leg.id==='base'),policy=base?.policies.find(item=>item.id==='primary');
  return base?.entry&&policy?.status==='closed'?{ret:policy.ret!,exitTime:policy.exitTime!,entry:base.entry.price,entryTime:base.entry.time,why:policy.why!}:null;
}

/** A trade is finished when every leg is closed or missed; unfinished trades still wait for settlement. */
export function shadowFinished(trade:ShadowTrade):boolean {
  return trade.done||trade.legs.every(leg=>leg.status==='closed'||leg.status==='missed');
}

/**
 * What is kept once nothing but the final result is pending: buckets, every closed policy's return, and what is
 * needed to settle the rest. Compacting early keeps stored sessions small without dropping late-game setups.
 */
export type ShadowResult={
  id:string;kind:'executed'|'candidate';strategy:string;version:string;slug:string;sport:string;setupKey?:string;createdAt:number;closedAt:number|null;
  context:ShadowTrade['context'];mae:number;mfe:number;primary:ReturnType<typeof primaryResult>;
  /** [leg, policy, net return] for every policy that closed. */
  results:[string,string,number][];
  /** Settlement-only policies still open: [leg, policy, side, entry price, entry fee, entry time, markout]. */
  awaiting:[string,string,SideKey,number,number,number,boolean][];
};

const settlementOnly=(trade:ShadowTrade,id:string)=>rulesOf(trade,id).every(rule=>rule.kind==='settlement'||rule.kind==='markout')&&rulesOf(trade,id).some(rule=>rule.kind==='settlement');
/** Ready to compact: no leg is waiting to enter, and every open policy only waits for the final result. */
export function shadowReadyToCompact(trade:ShadowTrade):boolean {
  return trade.done||trade.legs.every(leg=>leg.status==='closed'||leg.status==='missed'||(leg.status==='open'&&leg.policies.every(p=>p.status==='closed'||settlementOnly(trade,p.id))));
}
export function compactShadow(trade:ShadowTrade,time:number):ShadowResult {
  return {id:trade.id,kind:trade.kind,strategy:trade.strategy,version:trade.version,slug:trade.slug,sport:trade.sport,...(trade.setupKey?{setupKey:trade.setupKey}:{}),
    createdAt:trade.createdAt,closedAt:trade.done?trade.closedAt??time:null,context:trade.context,mae:trade.mae,mfe:trade.mfe,primary:primaryResult(trade),
    results:trade.legs.flatMap(leg=>leg.policies.filter(p=>p.status==='closed'&&typeof p.ret==='number').map(p=>[leg.id,p.id,p.ret!] as [string,string,number])),
    awaiting:trade.legs.flatMap(leg=>leg.entry?leg.policies.filter(p=>p.status==='open').map(p=>[leg.id,p.id,leg.side,leg.entry!.price,leg.entry!.fee,leg.entry!.time,
      rulesOf(trade,p.id).some(rule=>rule.kind==='markout')] as [string,string,SideKey,number,number,number,boolean]):[])};
}
/** Settle a compacted shadow's awaiting policies at the YES settlement value (no exit fee at settlement). */
export function settleResult(result:ShadowResult,yesSettlement:number,time:number):ShadowResult {
  for(const [leg,policy,side,price,fee,entryTime,markout] of result.awaiting){
    const value=side==='yes'?yesSettlement:1-yesSettlement,ret=round(markout?(value-price-fee)/price:(value-price-fee)/(price+fee));
    result.results.push([leg,policy,ret]);
    if(leg==='base'&&policy==='primary')result.primary={ret,exitTime:time,entry:price,entryTime,why:'settlement'};
  }
  result.awaiting=[];result.closedAt=time;
  return result;
}
