import {feeUnits,fromUnits,notionalUnits,toUnits} from '../trading/money.ts';

export const ADAPTIVE_EXIT_VERSION='adaptive-exit-v1' as const;
const EPSILON=1e-7;
const finite=(value:number)=>Number.isFinite(value);
const bounded=(value:number,low:number,high:number)=>Math.min(high,Math.max(low,value));

/** These values are copied once at the actual entry fill, never from later settings. */
export type AdaptiveExitPlan={
  version:typeof ADAPTIVE_EXIT_VERSION;
  openedAt:number;entryAllInUnitCost:number;
  risk:{targetReturn:number;stopReturn:number;maxHoldMs:number};
  thesis:{referenceBid:number;riskPrice:number;volatilityPerSqrtSecond:number;horizonMs:number;frictionPerShare:number};
  executionDelayMs:number;tickSize:number;
};
export type ExitEvidenceKind='THESIS_INVALID'|'OPPORTUNITY_DECAY';
export type AdaptiveExitState={
  version:typeof ADAPTIVE_EXIT_VERSION;lastBookTime:number|null;
  highWaterNetReturn:number|null;trailingFloorReturn:number;
  evidence:{kind:ExitEvidenceKind|null;since:number|null;samples:number};
  exitCode?:string;exitReason?:string;
};
export type AdaptiveExitInput={
  plan:AdaptiveExitPlan;priorState?:AdaptiveExitState;now:number;maxBookAgeMs:number;
  mark:{bookTime:number|null;netLiquidationValue:number|null;liquidationQuantity:number;remainingQuantity:number;remainingCostBasis:number};
  market:{bid:number;ask:number;volatilityPerSqrtSecond:number;recoveryDriftLowerPerSecond:number|null;imbalance:number;feeCoefficient:number};
  forcedReason?:string;
};
export type AdaptiveExitMetrics={
  heldMs:number;markAgeMs:number|null;liquidationQuantity:number;liquidityFraction:number;completeMark:boolean;
  netReturn:number|null;peakNetReturn:number|null;trailingFloorReturn:number;
  volatilityPerSqrtSecond:number|null;reactionWindowMs:number;noiseBufferReturn:number|null;
  referenceNetReturn:number|null;remainingHeadroomReturn:number|null;continuationRiskReturn:number|null;
  recoveryDriftLowerPerSecond:number|null;imbalance:number|null;
  evidenceKind:ExitEvidenceKind|null;evidenceSamples:number;evidenceAgeMs:number;
};
export type AdaptiveExitAssessment={
  version:typeof ADAPTIVE_EXIT_VERSION;action:'hold'|'exit';code:string;reason:string;
  state:AdaptiveExitState;metrics:AdaptiveExitMetrics;
  marketMeasurement?:ExitMarketMeasurement;
};

export type ExitMarketPoint={time:number;price:number;bid?:number;ask?:number};
export type ExitMarketMeasurement={
  available:boolean;code:string;reason:string;samples:number;historyMs:number;lastBookTime:number|null;
  volatilityPerSqrtSecond:number|null;recoveryDriftLowerPerSecond:number|null;
  driftPerSecond:number|null;driftStandardErrorPerSecond:number|null;
};

/**
 * Recent held-side diffusion and drift, independent of any entry pattern.
 * Drift is total bid change / total elapsed seconds. Diffusion is the residual
 * increment variance per second, using the larger estimate from bid and midpoint.
 * This differs from entry's pre-drop baseline: recent reversals belong in exit
 * risk. A two-standard-error drift envelope is a policy assumption, not a fitted
 * confidence probability. No imputation, future samples or duplicate weighting.
 */
export function measureExitMarket(history:readonly ExitMarketPoint[],now:number,windowMs:number):ExitMarketMeasurement{
  const result:ExitMarketMeasurement={available:false,code:'EXIT_HISTORY_INPUT',reason:'Recent executable history is unavailable.',
    samples:0,historyMs:0,lastBookTime:null,volatilityPerSqrtSecond:null,recoveryDriftLowerPerSecond:null,
    driftPerSecond:null,driftStandardErrorPerSecond:null};
  const unavailable=(code:string,reason:string)=>({...result,code,reason});
  if(!finite(now)||now<0||!finite(windowMs)||windowMs<=0)
    return unavailable('EXIT_HISTORY_INPUT','Recent exit analysis needs a finite clock and history window.');
  const window=bounded(windowMs,30_000,300_000);
  const points:{time:number;bid:number;mid:number;ask:number}[]=[];
  for(const point of history.filter(p=>finite(p.time)&&p.time<=now&&p.time>=now-window).sort((a,b)=>a.time-b.time)){
    if(typeof point.bid!=='number'||typeof point.ask!=='number'||!finite(point.bid)||!finite(point.ask)||point.bid<=0||point.ask>=1||point.bid>point.ask)
      return unavailable('EXIT_HISTORY_QUOTES','Recent bid and ask measurements contain an invalid or missing executable quote.');
    const previous=points.at(-1);
    if(previous?.time===point.time){
      if(previous.bid!==point.bid||previous.ask!==point.ask)
        return unavailable('EXIT_HISTORY_CONFLICT','Conflicting executable quotes share a receipt time.');
      continue;
    }
    points.push({time:point.time,bid:point.bid,ask:point.ask,mid:(point.bid+point.ask)/2});
  }
  result.samples=points.length;result.lastBookTime=points.at(-1)?.time??null;
  result.historyMs=points.length?points.at(-1)!.time-points[0].time:0;
  if(points.length<4)return unavailable('EXIT_HISTORY_WARMUP','At least three distinct recent quote intervals are needed to measure held-position noise.');
  if(now-points.at(-1)!.time>5_000)return unavailable('EXIT_HISTORY_STALE','Recent exit measurements end more than five seconds ago.');
  if(points.slice(1).some((p,i)=>p.time-points[i].time>15_000))
    return unavailable('EXIT_HISTORY_GAP','Recent exit measurements have a quote gap over fifteen seconds.');
  const seconds=result.historyMs/1000;
  const bidDrift=(points.at(-1)!.bid-points[0].bid)/seconds;
  const diffusion=(field:'bid'|'mid')=>{
    const drift=(points.at(-1)![field]-points[0][field])/seconds;
    const variance=points.slice(1).reduce((sum,p,i)=>{
      const dt=(p.time-points[i].time)/1000;
      return sum+(p[field]-points[i][field]-drift*dt)**2/dt;
    },0)/(points.length-2);
    return Math.sqrt(variance);
  };
  const sigma=Math.max(diffusion('bid'),diffusion('mid'));
  const standardError=sigma/Math.sqrt(seconds),lower=bidDrift-2*standardError;
  if(![seconds,bidDrift,sigma,standardError,lower].every(finite))
    return unavailable('EXIT_HISTORY_NUMERIC','Recent exit measurements exceed the supported numeric range.');
  return {...result,available:true,code:'EXIT_HISTORY_READY',reason:'Recent executable bid and midpoint changes measured locally.',
    volatilityPerSqrtSecond:sigma,recoveryDriftLowerPerSecond:lower,driftPerSecond:bidDrift,driftStandardErrorPerSecond:standardError};
}

function validPlan(plan:AdaptiveExitPlan){
  return plan.version===ADAPTIVE_EXIT_VERSION&&finite(plan.openedAt)&&plan.openedAt>=0&&
    finite(plan.entryAllInUnitCost)&&plan.entryAllInUnitCost>0&&
    finite(plan.risk.targetReturn)&&plan.risk.targetReturn>=0&&finite(plan.risk.stopReturn)&&plan.risk.stopReturn>0&&plan.risk.stopReturn<1&&
    finite(plan.risk.maxHoldMs)&&plan.risk.maxHoldMs>0&&finite(plan.executionDelayMs)&&plan.executionDelayMs>0&&
    finite(plan.tickSize)&&plan.tickSize>0&&plan.tickSize<1&&
    finite(plan.thesis.referenceBid)&&plan.thesis.referenceBid>0&&plan.thesis.referenceBid<1&&
    finite(plan.thesis.riskPrice)&&plan.thesis.riskPrice>=0&&plan.thesis.riskPrice<1&&
    finite(plan.thesis.volatilityPerSqrtSecond)&&plan.thesis.volatilityPerSqrtSecond>=0&&
    finite(plan.thesis.horizonMs)&&plan.thesis.horizonMs>0&&finite(plan.thesis.frictionPerShare)&&plan.thesis.frictionPerShare>=0;
}

export function createExitPlan(input:Omit<AdaptiveExitPlan,'version'>):AdaptiveExitPlan{
  const plan:AdaptiveExitPlan={...structuredClone(input),version:ADAPTIVE_EXIT_VERSION};
  if(!validPlan(plan))throw new RangeError('Adaptive exit needs finite entry evidence and immutable risk limits.');
  plan.thesis.horizonMs=Math.min(plan.thesis.horizonMs,plan.risk.maxHoldMs);
  return plan;
}

/**
 * Local stopping policy, not a win-probability or expected-return forecast.
 *
 * The reference bid is the entry analysis's observed recovery scenario. Its
 * fee-rounded liquidation proceeds are compared with executable proceeds now.
 * The cost of waiting is a two-sigma delay band plus negative measured drift and
 * the adverse half-spread microprice displacement. These are disclosed model
 * assumptions, not calibrated confidence probabilities. Existing fees are sunk:
 * entry fees are already in cost basis and exit fees in the executable mark;
 * they are never subtracted for a second time.
 *
 * A full executable peak ratchets a profit floor at peak minus the larger of
 * two-sigma delay noise, half-spread and one tick. New noise cannot lower that
 * floor. Structural invalidation and exhausted recovery headroom require two
 * distinct fresh books spanning at least the frozen execution delay. Hard loss,
 * elapsed maximum time and an already requested exit do not wait for evidence.
 * Returning `exit` is only a proposal: the reducer's delayed, price-bounded IOC
 * matcher must still obtain a later fresh book; this function cannot fill orders.
 */
export function assessAdaptiveExit(input:AdaptiveExitInput):AdaptiveExitAssessment{
  const {plan,mark,market,now}=input;
  const floor=validPlan(plan)?-plan.risk.stopReturn:0;
  const prior=input.priorState;
  const state:AdaptiveExitState=prior?.version===ADAPTIVE_EXIT_VERSION?structuredClone(prior):{
    version:ADAPTIVE_EXIT_VERSION,lastBookTime:null,highWaterNetReturn:null,trailingFloorReturn:floor,
    evidence:{kind:null,since:null,samples:0},
  };
  // A saved state may tighten risk but must never widen the entry's original bound.
  state.trailingFloorReturn=Math.max(floor,finite(state.trailingFloorReturn)?state.trailingFloorReturn:floor);
  const reactionWindowMs=validPlan(plan)?Math.max(1_000,plan.executionDelayMs):1_000;
  const metrics:AdaptiveExitMetrics={heldMs:finite(now)&&finite(plan.openedAt)?Math.max(0,now-plan.openedAt):0,
    markAgeMs:mark.bookTime!==null&&finite(mark.bookTime)&&finite(now)?now-mark.bookTime:null,
    liquidationQuantity:finite(mark.liquidationQuantity)?mark.liquidationQuantity:0,liquidityFraction:0,completeMark:false,
    netReturn:null,peakNetReturn:state.highWaterNetReturn,trailingFloorReturn:state.trailingFloorReturn,
    volatilityPerSqrtSecond:null,reactionWindowMs,noiseBufferReturn:null,referenceNetReturn:null,remainingHeadroomReturn:null,
    continuationRiskReturn:null,recoveryDriftLowerPerSecond:null,imbalance:null,evidenceKind:state.evidence.kind,
    evidenceSamples:state.evidence.samples,evidenceAgeMs:0};
  const result=(action:'hold'|'exit',code:string,reason:string):AdaptiveExitAssessment=>{
    metrics.peakNetReturn=state.highWaterNetReturn;metrics.trailingFloorReturn=state.trailingFloorReturn;
    metrics.evidenceKind=state.evidence.kind;metrics.evidenceSamples=state.evidence.samples;
    metrics.evidenceAgeMs=state.evidence.since!==null&&finite(now)?Math.max(0,now-state.evidence.since):0;
    if(action==='exit'){state.exitCode=code;state.exitReason=reason;}
    return {version:ADAPTIVE_EXIT_VERSION,action,code,reason,state,metrics};
  };
  if(!validPlan(plan)||!finite(now)||now<plan.openedAt||!finite(input.maxBookAgeMs)||input.maxBookAgeMs<=0||
    !finite(mark.remainingQuantity)||mark.remainingQuantity<=0||!finite(mark.remainingCostBasis)||mark.remainingCostBasis<=0)
    return result('hold','INVALID_EXIT_INPUT','Exit assessment needs valid frozen entry evidence and a reconciled remaining position.');
  if(metrics.markAgeMs===null||metrics.markAgeMs<0||metrics.markAgeMs>Math.min(5_000,input.maxBookAgeMs)||mark.bookTime!<plan.openedAt||
    (state.lastBookTime!==null&&mark.bookTime!<state.lastBookTime))
    return result('hold','STALE_EXIT_MARK','Waiting for a fresh, ordered executable liquidation quote; old quotes cannot move the exit floor.');
  if(mark.netLiquidationValue===null||!finite(mark.netLiquidationValue)||mark.netLiquidationValue<0||
    !finite(mark.liquidationQuantity)||mark.liquidationQuantity<=0||mark.liquidationQuantity>mark.remainingQuantity+EPSILON)
    return result('hold','NO_EXIT_DEPTH','No valid executable buyer quantity is available; the position remains open until an exit can be quoted.');

  const unitCost=mark.remainingCostBasis/mark.remainingQuantity;
  metrics.liquidityFraction=bounded(mark.liquidationQuantity/mark.remainingQuantity,0,1);
  metrics.completeMark=mark.liquidationQuantity>=mark.remainingQuantity-EPSILON;
  metrics.netReturn=mark.netLiquidationValue/(unitCost*mark.liquidationQuantity)-1;
  if(input.forcedReason)return result('exit','EXIT_REQUESTED',input.forcedReason);
  if(state.exitCode)return result('exit',state.exitCode,state.exitReason??'A previous executable exit decision remains active.');
  if(metrics.netReturn<=-plan.risk.stopReturn+EPSILON)
    return result('exit','HARD_STOP','The available liquidation return reached the original loss limit after fees; reducing available quantity.');
  if(metrics.heldMs>=plan.risk.maxHoldMs)
    return result('exit','MAX_HOLD','The original maximum holding time expired; attempting to close available quantity.');

  if(!finite(market.bid)||!finite(market.ask)||market.bid<=0||market.ask>=1||market.ask<market.bid||
    !finite(market.volatilityPerSqrtSecond)||market.volatilityPerSqrtSecond<0||
    (market.recoveryDriftLowerPerSecond!==null&&!finite(market.recoveryDriftLowerPerSecond))||
    !finite(market.imbalance)||Math.abs(market.imbalance)>1+EPSILON||!finite(market.feeCoefficient)||market.feeCoefficient<0||market.feeCoefficient>1)
    return result('hold','EXIT_ANALYSIS_UNAVAILABLE','Hard risk limits remain active; adaptive exit needs valid local volatility and book measurements.');
  const sigma=Math.max(plan.thesis.volatilityPerSqrtSecond,market.volatilityPerSqrtSecond);
  const spread=market.ask-market.bid;
  const noise=Math.max(plan.tickSize,spread/2,2*sigma*Math.sqrt(reactionWindowMs/1000));
  const adverseDrift=Math.max(0,-(market.recoveryDriftLowerPerSecond??0))*reactionWindowMs/1000;
  const adversePressure=Math.max(0,-market.imbalance)*spread/2;
  if(![noise,adverseDrift,adversePressure,noise/unitCost,(noise+adverseDrift+adversePressure)/unitCost].every(finite))
    return result('hold','EXIT_ANALYSIS_UNAVAILABLE','Hard risk limits remain active; adaptive exit measurements exceed the supported numeric range.');
  metrics.volatilityPerSqrtSecond=sigma;metrics.noiseBufferReturn=noise/unitCost;
  metrics.continuationRiskReturn=(noise+adverseDrift+adversePressure)/unitCost;
  metrics.recoveryDriftLowerPerSecond=market.recoveryDriftLowerPerSecond;metrics.imbalance=market.imbalance;
  try{
    const size=toUnits(mark.remainingQuantity),price=toUnits(plan.thesis.referenceBid);
    const referenceNet=fromUnits(notionalUnits(size,price)-feeUnits(size,price,toUnits(market.feeCoefficient)));
    metrics.referenceNetReturn=referenceNet/mark.remainingCostBasis-1;
    metrics.remainingHeadroomReturn=metrics.referenceNetReturn-metrics.netReturn;
  }catch{
    return result('hold','EXIT_ANALYSIS_UNAVAILABLE','Hard risk limits remain active; reference liquidation fees could not be computed safely.');
  }

  // Polling a cached receipt cannot manufacture confirmations or new profit peaks.
  if(state.lastBookTime===mark.bookTime)
    return result('hold','UNCHANGED_EXIT_BOOK','The same executable book was already assessed; waiting for new exit evidence.');
  const gap=state.lastBookTime===null?0:mark.bookTime!-state.lastBookTime;
  if(gap>Math.min(5_000,input.maxBookAgeMs))state.evidence={kind:null,since:null,samples:0};
  state.lastBookTime=mark.bookTime;
  if(metrics.completeMark){
    state.highWaterNetReturn=Math.max(state.highWaterNetReturn??metrics.netReturn,metrics.netReturn);
    // Only a net gain larger than the measured noise can arm profit protection.
    if(state.highWaterNetReturn>metrics.noiseBufferReturn)
      state.trailingFloorReturn=Math.max(state.trailingFloorReturn,0,state.highWaterNetReturn-metrics.noiseBufferReturn);
  }
  if(state.trailingFloorReturn>floor+EPSILON&&metrics.netReturn<=state.trailingFloorReturn+EPSILON)
    return result('exit','VOLATILITY_TRAIL','Executable profit fell through its ratcheted volatility buffer; protecting the remaining gain with a delayed exit.');

  // A partial quote can support loss reduction, but cannot prove total profit.
  const brokenThesis=market.bid+noise<plan.thesis.riskPrice-EPSILON;
  const exhaustedHeadroom=metrics.remainingHeadroomReturn<=metrics.continuationRiskReturn+EPSILON;
  const expiredWeakRecovery=metrics.heldMs>=plan.thesis.horizonMs&&market.recoveryDriftLowerPerSecond!==null&&
    market.recoveryDriftLowerPerSecond<=0&&market.imbalance<=0;
  const kind:ExitEvidenceKind|null=brokenThesis?'THESIS_INVALID':
    metrics.completeMark&&metrics.netReturn>0&&(exhaustedHeadroom||expiredWeakRecovery)?'OPPORTUNITY_DECAY':null;
  if(kind===null)state.evidence={kind:null,since:null,samples:0};
  else if(state.evidence.kind===kind){state.evidence.samples++;}
  else state.evidence={kind,since:mark.bookTime,samples:1};
  if(kind&&state.evidence.samples>=2&&mark.bookTime!-state.evidence.since!>=reactionWindowMs){
    return result('exit',kind,kind==='THESIS_INVALID'?
      'Distinct fresh buyer quotes broke the entry thesis beyond its volatility buffer; exiting before the original loss limit.':
      exhaustedHeadroom?'The fee-adjusted recovery headroom is smaller than the measured cost of waiting on consecutive fresh books; taking available profit.':
        'The original recovery horizon elapsed with nonpositive measured recovery and buyer pressure; taking available profit.');
  }
  return result('hold',kind?'EXIT_EVIDENCE_FORMING':'ADAPTIVE_HOLD',kind?
    'An adaptive exit condition is forming; confirming it on distinct fresh books before changing the position.':
    metrics.completeMark?exhaustedHeadroom?
      'Recovery headroom is weak and there is no net gain to harvest; watching thesis invalidation while the original loss/time limits remain active.':
      'Holding: remaining recovery headroom exceeds the measured waiting risk; the original loss/time limits and trailing floor remain active.':
      'Only part of the position has executable buyers; profit-taking needs a full mark while loss and time exits still manage available quantity.');
}
