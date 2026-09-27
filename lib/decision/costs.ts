import type {Role} from './evidence.ts';

/** Per-contract estimates for decisions and explanations. Ledger money stays in lib/trading/money.ts. */

export const DEFAULT_FEE_COEFFICIENT=0.0695;
/** Research treats wider books as placeholder quotes, not executable prices. */
export const MAX_EXECUTABLE_SPREAD=0.05;
const EPSILON=1e-9;

export type Costs={
  entryFee:number;costPerContract:number;
  /** Hold to settlement: the side must win at least this often to break even. */
  breakEvenWinRate:number;
  /** Market-implied win probability from the bid/ask midpoint, when a bid is known. */
  impliedProbability:number|null;
  spread:number|null;
  /** Scalp: how far the bid must rise above today's ask for a round trip to break even, in dollars. */
  breakEvenBidRise:number;
};

export const takerFee=(price:number,coefficient:number)=>coefficient*price*(1-price);

export function estimateCosts(ask:number,bid:number|null|undefined,coefficient=DEFAULT_FEE_COEFFICIENT):Costs {
  const entryFee=takerFee(ask,coefficient),costPerContract=ask+entryFee;
  // Smallest exit bid x with x - fee(x) >= cost; proceeds increase in x, so bisection converges.
  let lo=ask,hi=1;
  for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(mid-takerFee(mid,coefficient)>=costPerContract)hi=mid;else lo=mid;}
  const validBid=typeof bid==='number'&&Number.isFinite(bid)&&bid>0&&bid<=ask;
  return {entryFee,costPerContract,breakEvenWinRate:Math.min(1,costPerContract),
    impliedProbability:validBid?(ask+bid)/2:null,spread:validBid?ask-bid:null,breakEvenBidRise:hi-ask};
}

/** Favourite when the side's midpoint (or ask, without a bid) is at least 50¢, as in research/studies/pregame.py. */
export function roleOf(ask:number,bid?:number|null):Role {
  const mid=typeof bid==='number'&&Number.isFinite(bid)?(ask+bid)/2:ask;
  return mid>=0.5-EPSILON?'favourite':'underdog';
}
