import {takerFee} from './costs.ts';

/**
 * The bridge from a probability estimate to an executable decision (docs/STRATEGY-ARCHITECTURE.md#edge).
 *
 *   tradable edge = P(side wins), lower bound  −  (average fill price for the stake + taker fee + latency allowance)
 *
 * A point estimate is not enough: the lower bound of a calibrated interval must clear every cost, so model noise
 * and estimation error cannot create trades. Hold-to-settlement pays one fee (Polymarket US charges none at
 * settlement); round trips pay two, which is why temporary-mispricing strategies need much larger moves.
 */

export type FairEstimate={p:number;lo:number;hi:number;n?:number|null;source:string};
export type Level={price:number;quantity:number};
export type HoldEdge={
  fair:FairEstimate;averagePrice:number;contracts:number;
  /** Per contract, in probability units (dollars). */
  fee:number;slippage:number;latency:number;breakEven:number;
  /** p − breakEven, and lo − breakEven. */
  edge:number;lowerEdge:number;uncertainty:number;tradable:boolean;
};

const round=(x:number)=>Math.round(x*1e6)/1e6;

/** Walk the ask ladder (best first) to spend `stake` dollars. Null when the visible book cannot fill it. */
export function fillForStake(asks:readonly Level[],stake:number):{average:number;contracts:number}|null {
  if(!(stake>0))return null;
  const levels=[...asks].filter(level=>level.price>0&&level.price<1&&level.quantity>0).sort((a,b)=>a.price-b.price);
  let remaining=stake,contracts=0,spent=0;
  for(const level of levels){
    const take=Math.min(level.quantity,remaining/level.price);
    contracts+=take;spent+=take*level.price;remaining-=take*level.price;
    if(remaining<=1e-9)break;
  }
  return remaining>1e-9||contracts<=0?null:{average:spent/contracts,contracts};
}

export function holdEdge(input:{fair:FairEstimate;asks:readonly Level[];stake:number;feeCoefficient:number;latencyCents:number;minLowerEdge?:number}):HoldEdge|null {
  const {fair,asks,stake,feeCoefficient,latencyCents}=input;
  if(!(fair.lo<=fair.p&&fair.p<=fair.hi)||fair.lo<0||fair.hi>1)return null;
  const fill=fillForStake(asks,stake),best=[...asks].filter(level=>level.quantity>0).sort((a,b)=>a.price-b.price)[0];
  if(!fill||!best)return null;
  const fee=takerFee(fill.average,feeCoefficient),latency=Math.max(0,latencyCents)/100,slippage=fill.average-best.price;
  const breakEven=fill.average+fee+latency,edge=fair.p-breakEven,lowerEdge=fair.lo-breakEven;
  return {fair,averagePrice:round(fill.average),contracts:round(fill.contracts),fee:round(fee),slippage:round(slippage),latency:round(latency),
    breakEven:round(breakEven),edge:round(edge),lowerEdge:round(lowerEdge),uncertainty:round(fair.p-fair.lo),tradable:lowerEdge>(input.minLowerEdge??0)};
}

/**
 * Round trip (enter at the ask, exit later at a bid): the exit bid needed to break even, so a temporary-mispricing
 * hypothesis can be checked against the move it expects. Returns the required rise in the bid, in dollars.
 */
export function roundTripHurdle(ask:number,bid:number,feeCoefficient:number):{requiredExitBid:number;requiredRise:number} {
  const cost=ask+takerFee(ask,feeCoefficient);
  let lo=ask,hi=1;
  for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(mid-takerFee(mid,feeCoefficient)>=cost)hi=mid;else lo=mid;}
  return {requiredExitBid:round(hi),requiredRise:round(hi-bid)};
}
