import type {Costs} from './costs.ts';
import type {Evidence} from './evidence.ts';

/**
 * Stake sizing. Real money uses fractional Kelly on the evidence's LOWER bound, so a result whose
 * interval touches zero stakes nothing. Paper and pilot use a fixed small stake: they exist to measure.
 */

export type SizingLimits={
  bankroll:number;
  /** Fraction of full Kelly (handoff: 1/4). */
  kellyFraction:number;
  maxStake:number;maxBankrollFraction:number;
  /** Fixed stake for paper trades and pilot quotes. */
  paperStake:number;
};
export const DEFAULT_SIZING:SizingLimits=Object.freeze({bankroll:100,kellyFraction:0.25,maxStake:25,maxBankrollFraction:0.05,paperStake:5});

/** Full-Kelly bankroll fraction for a $1-payout contract costing `cost`, won with probability `q`. */
export function kellyFraction(q:number,cost:number):number {
  if(!(cost>0&&cost<1)||!(q>=0&&q<=1))return 0;
  const b=(1-cost)/cost;
  return Math.max(0,(b*q-(1-q))/b);
}

export function stakeFor(input:{action:'allow'|'paper-only'|'block';mode:'paper'|'pilot'|'real';evidence:Evidence|null;costs:Costs|null;limits:SizingLimits}):number {
  const {action,mode,evidence,costs,limits}=input;
  const cap=Math.max(0,Math.min(limits.maxStake,limits.bankroll*limits.maxBankrollFraction));
  if(action==='block')return 0;
  if(mode!=='real')return round(Math.min(limits.paperStake,cap));
  if(!evidence||!costs||evidence.estimate.unit!=='return'||evidence.estimate.lo===null||evidence.estimate.lo<=0)return 0;
  // Expected return r per dollar means win probability q = cost * (1 + r).
  const q=Math.min(1,costs.costPerContract*(1+evidence.estimate.lo));
  return round(Math.min(cap,limits.bankroll*limits.kellyFraction*kellyFraction(q,costs.costPerContract)));
}

const round=(x:number)=>Math.floor(x*100)/100;
