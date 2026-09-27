import {EVIDENCE,EVIDENCE_VERSION,formatEstimate,type Evidence,type Phase,type Role,type Sport,type Style} from './evidence.ts';

/**
 * Evidence-gated decision engine. Pure and deterministic: the same request always gets the same verdict.
 * Any bot, script or dashboard asks `decide` before an entry and `quotePolicy` before resting orders.
 * The default answer is no. Nothing here forecasts profit; it applies measured results only.
 */

/**
 * paper: simulated fills. pilot: small, capped real money used only to measure resting-order leads,
 * which price history cannot backtest. real: normal real money, proven strategies only.
 */
export type Mode='paper'|'pilot'|'real';
export type DecisionRequest={
  sport:Sport;phase:Phase;style:Style;mode:Mode;
  /** Price to buy the side being considered (its ask) and to sell it (its bid), in dollars per contract. */
  ask:number;bid?:number|null;
  /** Taker fee coefficient from market metadata. Research fallback is 0.0695. */
  feeCoefficient?:number;
  /** Optional outside probability estimate, reported for context only (models have not beaten the market). */
  modelProbability?:number|null;
};
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
export type Verdict={
  engine:typeof EVIDENCE_VERSION;
  action:'allow'|'paper-only'|'block';
  /** Whether this request, in its mode, may proceed. */
  permitted:boolean;
  code:'PROVEN'|'LEAD_PAPER'|'UNPROVEN_REAL'|'DROPPED'|'NO_EVIDENCE'|'NOT_EXECUTABLE'|'INVALID';
  reason:string;role:Role|null;
  evidence:Evidence[];deciding:Evidence|null;costs:Costs|null;
  modelEdge:number|null;
};

export const DEFAULT_FEE_COEFFICIENT=0.0695;
/** Research treats wider books as placeholder quotes, not executable prices. */
export const MAX_EXECUTABLE_SPREAD=0.05;
const EPSILON=1e-9;

const fee=(price:number,coefficient:number)=>coefficient*price*(1-price);
const inBand=(price:number,band:{min:number;max:number})=>price>band.min+EPSILON&&price<=band.max+EPSILON;

/** Per-contract estimates for explanation. Ledger money stays in lib/trading/money.ts. */
export function estimateCosts(ask:number,bid:number|null|undefined,coefficient=DEFAULT_FEE_COEFFICIENT):Costs {
  const entryFee=fee(ask,coefficient),costPerContract=ask+entryFee;
  // Smallest exit bid x with x - fee(x) >= cost; fee is concave, so bisection on the increasing proceeds curve.
  let lo=ask,hi=1;
  for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(mid-fee(mid,coefficient)>=costPerContract)hi=mid;else lo=mid;}
  const validBid=typeof bid==='number'&&Number.isFinite(bid)&&bid>0&&bid<=ask;
  return {entryFee,costPerContract,breakEvenWinRate:Math.min(1,costPerContract),
    impliedProbability:validBid?(ask+bid)/2:null,spread:validBid?ask-bid:null,
    breakEvenBidRise:hi-ask};
}

/** Favourite when the side's midpoint (or ask, without a bid) is at least 50¢, as in research/studies/pregame.py. */
export function roleOf(ask:number,bid?:number|null):Role {
  const mid=typeof bid==='number'&&Number.isFinite(bid)?(ask+bid)/2:ask;
  return mid>=0.5-EPSILON?'favourite':'underdog';
}

export function matchingEvidence(sport:Sport,phase:Phase,style:Style,price?:number,role?:Role):Evidence[] {
  return EVIDENCE.filter(item=>item.sports.includes(sport)&&item.phases.includes(phase)&&item.styles.includes(style)
    &&(!item.price||(price!==undefined&&inBand(price,item.price)))&&(!item.role||item.role===role));
}

/** Price- or role-specific findings outrank the general result for the same regime. */
const specificity=(item:Evidence)=>(item.price?2:0)+(item.role?1:0);
const mostSpecific=(items:Evidence[])=>[...items].sort((a,b)=>specificity(b)-specificity(a))[0]??null;

export function decide(request:DecisionRequest):Verdict {
  const base={engine:EVIDENCE_VERSION,modelEdge:null} as const;
  const {ask,bid}=request;
  const coefficient=request.feeCoefficient??DEFAULT_FEE_COEFFICIENT;
  if(!Number.isFinite(ask)||ask<=0||ask>=1||(bid!==undefined&&bid!==null&&(!Number.isFinite(bid)||bid<=0||bid>ask))||!Number.isFinite(coefficient)||coefficient<0)
    return {...base,action:'block',permitted:false,code:'INVALID',reason:'A valid price between 0 and 1 (and a bid not above the ask) is required.',role:null,evidence:[],deciding:null,costs:null};
  const costs=estimateCosts(ask,bid,coefficient),role=roleOf(ask,bid);
  const modelEdge=typeof request.modelProbability==='number'&&Number.isFinite(request.modelProbability)?request.modelProbability-costs.breakEvenWinRate:null;
  const evidence=matchingEvidence(request.sport,request.phase,request.style,ask,role);
  const out=(action:Verdict['action'],code:Verdict['code'],reason:string,deciding:Evidence|null):Verdict=>({
    ...base,modelEdge,action,permitted:action==='allow'||(action==='paper-only'&&request.mode==='paper'),code,reason,role,evidence,deciding,costs});
  if(request.style!=='maker'&&costs.spread!==null&&costs.spread>MAX_EXECUTABLE_SPREAD+EPSILON)
    return out('block','NOT_EXECUTABLE',`The ${Math.round(costs.spread*100)}¢ spread is wider than the 5¢ the research counts as a real price.`,null);
  const dropped=evidence.filter(item=>item.status==='dropped');
  if(dropped.length){
    const item=mostSpecific(dropped)!;
    return out('block','DROPPED',`${item.title}: ${formatEstimate(item.estimate)} measured (${item.sample}). ${item.plain}`,item);
  }
  const proven=evidence.filter(item=>item.status==='proven');
  if(proven.length){
    const item=mostSpecific(proven)!;
    return out('allow','PROVEN',`${item.title}: proven ${formatEstimate(item.estimate)} (${item.sample}).`,item);
  }
  const leads=evidence.filter(item=>item.status==='lead');
  if(leads.length){
    const item=mostSpecific(leads)!;
    // Taker leads can be measured on paper, so a pilot adds nothing; only paper may run them.
    return request.mode==='paper'
      ?out('paper-only','LEAD_PAPER',`${item.title}: unproven lead ${formatEstimate(item.estimate)}. Paper trading only, to settle the question.`,item)
      :out('block','UNPROVEN_REAL',`${item.title}: ${formatEstimate(item.estimate)} is not proven yet. Real money waits for the forward test.`,item);
  }
  return out('block','NO_EVIDENCE',`No study covers ${request.sport} ${request.phase} ${request.style} trades yet. The engine does not trade untested regimes.`,null);
}

export type QuotePolicy={
  engine:typeof EVIDENCE_VERSION;quote:boolean;status:'dropped'|'lead'|'proven'|'none';reason:string;
  evidence:Evidence|null;
  /** Pull resting orders for this long after a play/pitch event, from the reaction studies. */
  pullAfterEventMs:number|null;
};

/**
 * NFL: 88% of a big play's move is priced 30 s after the snap. MLB: 92% by 10 s after the official PA end.
 * CFB has no reaction study; it reuses the NFL window as an assumption until measured.
 */
const PULL_AFTER_EVENT_MS:Partial<Record<Sport,number>>={NFL:30_000,CFB:30_000,MLB:10_000};

export function quotePolicy(sport:Sport,phase:Phase,mode:Mode):QuotePolicy {
  const item=mostSpecific(matchingEvidence(sport,phase,'maker'));
  const pull=phase==='live'?PULL_AFTER_EVENT_MS[sport]??null:null;
  const base={engine:EVIDENCE_VERSION,evidence:item,pullAfterEventMs:pull} as const;
  if(!item)return {...base,quote:false,status:'none',reason:`No maker study covers ${sport} ${phase}.`};
  const summary=`${item.title}: ${formatEstimate(item.estimate)} per contract optimistic, ${item.conservative?formatEstimate(item.conservative):'n/a'} conservative, before rewards.`;
  if(item.status==='dropped')return {...base,quote:false,status:'dropped',reason:`${summary} Stay out.`};
  if(item.status==='proven')return {...base,quote:true,status:'proven',reason:summary};
  const permitted=mode!=='real';
  return {...base,quote:permitted,status:'lead',reason:permitted?`${summary} Paper or capped pilot only, to measure real fills and rewards.`:`${summary} Unproven; full real-money quoting waits for the pilot's result.`};
}
