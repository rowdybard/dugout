import type {Book, Level} from '../market/types';
import type {ExecutionMarket, ExecutionPolicy, TradeSide} from '../trading/types';
import {executePaperCommand} from '../trading/execution.ts';
import {feeUnits, fromUnits, notionalUnits, toUnits} from '../trading/money.ts';

export const OPPORTUNITY_VERSION = 'local-move-v1' as const;
export type OpportunityPoint = {time:number;price:number;bid?:number;ask?:number};
export type OpportunityInput = {
  /** History is already expressed in the selected outcome; book remains a YES book. */
  history:readonly OpportunityPoint[];book:Book;market:ExecutionMarket;side:TradeSide;
  now:number;bookReceivedAt:number;bookSource:'REST'|'WEBSOCKET'|'REPLAY';budget:number;cash:number;
  executionDelayMs:number;maxBookAgeMs?:number;maxSpreadPoints?:number;maxHoldMs?:number;
  minimumHistoryMs?:number;minSamples?:number;baselineWindowMs?:number;stopReturn?:number;
};
export type OpportunityMetrics = {
  samples:number;historyMs:number;ignoredFutureSamples:number;duplicateSamples:number;
  baselineSamples:number|null;baselineTime:number|null;troughTime:number|null;
  baselineMid:number|null;referenceBid:number|null;troughMid:number|null;troughBid:number|null;
  currentMid:number|null;bid:number|null;ask:number|null;spread:number|null;
  dropMagnitude:number|null;dropDurationMs:number|null;dropSpeedPerSecond:number|null;dropSigma:number|null;
  volatilityPerSqrtSecond:number|null;quantizationFloorPerSqrtSecond:number|null;volatilityWasClipped:boolean;
  recoveryMagnitude:number|null;bidRecoveryMagnitude:number|null;recoveryFraction:number|null;recoveryDurationMs:number|null;
  recoverySamples:number|null;positiveBidChanges:number|null;recoveryDriftPerSecond:number|null;
  driftStandardErrorPerSecond:number|null;recoveryDriftLowerPerSecond:number|null;
  depthBand:number|null;bidDepth:number|null;askDepth:number|null;imbalance:number|null;microprice:number|null;
  adverseBookShift:number|null;buyQuantity:number|null;entryCost:number|null;entryFees:number|null;exitFees:number|null;
  entrySlippagePerShare:number|null;exitSlippagePerShare:number|null;roundTripCostPerShare:number|null;
  fullEntryDepth:boolean;fullExitDepth:boolean;horizonMs:number|null;uncertaintyPerShare:number|null;
  delayFrictionPerShare:number|null;frictionPerShare:number|null;lowerMovePerShare:number|null;
  referenceScenarioNetPerShare:number|null;modeledExitFees:number|null;modeledExitBid:number|null;netHeadroomPerShare:number|null;netHeadroom:number|null;
  riskPerShare:number|null;netRewardRiskRatio:number|null;
};
export type OpportunityEntry = {
  quantity:number;cost:number;limitPrice:number;referenceBid:number;troughBid:number;riskPrice:number;
  volatilityPerSqrtSecond:number;horizonMs:number;netHeadroom:number;frictionPerShare:number;
};
export type OpportunityAnalysis = {
  version:typeof OPPORTUNITY_VERSION;decision:'enter'|'wait'|'reject';code:string;reason:string;
  reasons:{code:string;reason:string;decision:'wait'|'reject'}[];
  thresholds:{minimumHistoryMs:number;minSamples:number;baselineWindowMs:number;minimumBaselineSamples:number;
    minimumRecoveryIntervals:number;minimumPositiveBidChanges:number;minimumDropSigma:number;uncertaintyMultiplier:number;
    minimumNetRewardRiskRatio:number;minimumNetTickMultiples:number;volatilityClipMadMultiples:number;
    quantizationVarianceDivisor:number;maximumSpread:number;maxBookAgeMs:number;maximumGapMs:number;maxHoldMs:number};
  metrics:OpportunityMetrics;entry?:OpportunityEntry;
};

const EPS=1e-9;
const round=(value:number)=>Math.round(value*1e9)/1e9;
const money=(value:number)=>Math.round(value*1e6)/1e6;
const median=(values:number[])=>{const a=[...values].sort((x,y)=>x-y),n=a.length;return n?(n%2?a[n>>1]:(a[n/2-1]+a[n/2])/2):0;};
const emptyMetrics=():OpportunityMetrics=>({samples:0,historyMs:0,ignoredFutureSamples:0,duplicateSamples:0,
  baselineSamples:null,baselineTime:null,troughTime:null,baselineMid:null,referenceBid:null,troughMid:null,troughBid:null,
  currentMid:null,bid:null,ask:null,spread:null,dropMagnitude:null,dropDurationMs:null,dropSpeedPerSecond:null,dropSigma:null,
  volatilityPerSqrtSecond:null,quantizationFloorPerSqrtSecond:null,volatilityWasClipped:false,recoveryMagnitude:null,
  bidRecoveryMagnitude:null,recoveryFraction:null,recoveryDurationMs:null,recoverySamples:null,positiveBidChanges:null,
  recoveryDriftPerSecond:null,driftStandardErrorPerSecond:null,recoveryDriftLowerPerSecond:null,depthBand:null,bidDepth:null,
  askDepth:null,imbalance:null,microprice:null,adverseBookShift:null,buyQuantity:null,entryCost:null,entryFees:null,exitFees:null,
  entrySlippagePerShare:null,exitSlippagePerShare:null,roundTripCostPerShare:null,fullEntryDepth:false,fullExitDepth:false,
  horizonMs:null,uncertaintyPerShare:null,delayFrictionPerShare:null,frictionPerShare:null,lowerMovePerShare:null,
  referenceScenarioNetPerShare:null,modeledExitFees:null,modeledExitBid:null,netHeadroomPerShare:null,netHeadroom:null,riskPerShare:null,netRewardRiskRatio:null});

/**
 * Local, causal diffusion envelope with an observed pre-drop bid as an upper scenario.
 * It is deliberately not a win probability, fitted predictor, or expected profit.
 * Prices are dollars per contract and volatility is dollars / sqrt(second).
 * Returns are scaled by elapsed time, winsorized against baseline MAD, and floored
 * by tick quantization variance. The move itself never trains its baseline noise.
 */
export function analyzeOpportunity(input:OpportunityInput):OpportunityAnalysis {
  const thresholds={minimumHistoryMs:Math.max(30_000,input.minimumHistoryMs??30_000),minSamples:Math.max(10,input.minSamples??10),
    baselineWindowMs:input.baselineWindowMs??60_000,minimumBaselineSamples:6,minimumRecoveryIntervals:2,
    minimumPositiveBidChanges:2,minimumDropSigma:2,uncertaintyMultiplier:2,minimumNetRewardRiskRatio:1,
    minimumNetTickMultiples:1,volatilityClipMadMultiples:3,quantizationVarianceDivisor:12,
    maximumSpread:Math.min(.02,(input.maxSpreadPoints??2)/100),maxBookAgeMs:Math.min(5000,input.maxBookAgeMs??5000),
    maximumGapMs:15_000,maxHoldMs:input.maxHoldMs??120_000};
  const metrics=emptyMetrics(),reasons:OpportunityAnalysis['reasons']=[];
  const add=(decision:'wait'|'reject',code:string,reason:string)=>reasons.push({decision,code,reason});
  const finish=(entry?:OpportunityEntry):OpportunityAnalysis=>{
    // Rounding is only for recorded diagnostics, never the decision calculations.
    for(const key of Object.keys(metrics) as (keyof OpportunityMetrics)[]) {
      const value=metrics[key];if(typeof value==='number')Object.assign(metrics,{[key]:Number.isFinite(value)?round(value):null});
    }
    const first=reasons.find(r=>r.decision==='reject')??reasons[0];
    for(const key of Object.keys(thresholds) as (keyof typeof thresholds)[])if(!Number.isFinite(thresholds[key]))thresholds[key]=0;
    return {version:OPPORTUNITY_VERSION,decision:first?.decision??'enter',code:first?.code??'LOCAL_MOVE_READY',
      reason:first?.reason??'Executable buyer recovery exceeds measured noise, modeled friction and the structural risk allowance.',
      reasons,thresholds,metrics,...(!first&&entry?{entry}:{})};
  };
  if(![input.now,input.bookReceivedAt,input.budget,input.cash,input.executionDelayMs,...Object.values(thresholds)].every(Number.isFinite)
    ||input.budget<=0||input.cash<0||input.executionDelayMs<0||thresholds.baselineWindowMs<=0||thresholds.maxHoldMs<=0
    ||thresholds.maximumSpread<=0||thresholds.maxBookAgeMs<=0||!Number.isFinite(input.market.priceIncrement)||input.market.priceIncrement<=0) {
    add('reject','ANALYSIS_INPUT','The local analysis received invalid timing, sizing or market rules.');return finish();
  }
  if(input.bookReceivedAt>input.now||input.now-input.bookReceivedAt>thresholds.maxBookAgeMs||input.bookSource==='REPLAY')
    add('reject','BOOK_STALE','A current authoritative book no older than five seconds is required.');
  const normalize=(levels:Level[],complement:boolean)=>levels.map(p=>({price:money(complement?1-p.price:p.price),quantity:p.quantity})).filter(p=>p.quantity>0);
  if(!Array.isArray(input.book.bids)||!Array.isArray(input.book.asks)||[...input.book.bids,...input.book.asks].some(p=>!Number.isFinite(p.price)||p.price<=0||p.price>=1||!Number.isFinite(p.quantity)||p.quantity<0)) {
    add('reject','BOOK_INVALID','A valid two-sided depth book is required.');return finish();
  }
  const bids=normalize(input.side==='YES'?input.book.bids:input.book.asks,input.side==='NO').sort((a,b)=>b.price-a.price);
  const asks=normalize(input.side==='YES'?input.book.asks:input.book.bids,input.side==='NO').sort((a,b)=>a.price-b.price);
  if(!bids.length||!asks.length||bids[0].price>asks[0].price){add('reject','BOOK_INVALID','The depth book is empty or crossed.');return finish();}
  const bid=bids[0].price,ask=asks[0].price,mid=(bid+ask)/2,tick=input.market.priceIncrement,spread=ask-bid;
  Object.assign(metrics,{bid,ask,currentMid:mid,spread});
  if(spread>thresholds.maximumSpread+EPS)add('reject','SPREAD','The executable spread exceeds the unchanged two-cent limit.');
  const depthBand=Math.max(tick*2,spread);
  const bidDepth=bids.filter(p=>p.price>=bid-depthBand-EPS).reduce((s,p)=>s+p.quantity,0);
  const askDepth=asks.filter(p=>p.price<=ask+depthBand+EPS).reduce((s,p)=>s+p.quantity,0);
  const imbalance=(bidDepth-askDepth)/(bidDepth+askDepth),microprice=(ask*bidDepth+bid*askDepth)/(bidDepth+askDepth);
  const adverseBookShift=Math.max(0,mid-microprice);
  Object.assign(metrics,{depthBand,bidDepth,askDepth,imbalance,microprice,adverseBookShift});
  const policy:ExecutionPolicy={now:input.now,bookReceivedAt:input.bookReceivedAt,bookSource:input.bookSource,stateCertain:true,
    maxBookAgeMs:thresholds.maxBookAgeMs,maxCommandAgeMs:30_000,maxOrderBudget:input.budget,maxMarketExposure:input.budget,
    maxTotalExposure:input.budget,automation:'PAPER'};
  const command={commandId:'local-move-analysis',marketSlug:input.market.slug,side:input.side,source:'AUTOMATIC' as const,
    createdAt:input.now,strategyVersion:OPPORTUNITY_VERSION};
  const buy=executePaperCommand({...command,action:'BUY',budget:input.budget,limitPrice:ask},
    {cash:input.cash,marketExposure:0,totalExposure:0,availableQuantity:0},input.market,input.book,policy);
  const quantity=buy.filledQty,cost=-buy.cashDelta;
  if(buy.status!=='filled'||!buy.apply)add('reject','ENTRY_DEPTH',`The entire entry must execute at the current ask. ${buy.reason}`);
  const sell=quantity>0?executePaperCommand({...command,action:'SELL',quantity,limitPrice:bids.at(-1)!.price},
    {cash:money(input.cash-cost),marketExposure:cost,totalExposure:cost,availableQuantity:quantity},input.market,input.book,policy):null;
  metrics.fullEntryDepth=buy.status==='filled';metrics.fullExitDepth=sell?.status==='filled';
  if(quantity>0){Object.assign(metrics,{buyQuantity:quantity,entryCost:cost,entryFees:buy.fees,exitFees:sell?.fees??null,
    entrySlippagePerShare:buy.averagePrice-ask,exitSlippagePerShare:sell?.apply?bid-sell.averagePrice:null,
    roundTripCostPerShare:sell?.status==='filled'?(cost-sell.cashDelta)/quantity:null});}
  if(quantity>0&&sell?.status!=='filled')add('reject','EXIT_DEPTH','The displayed bid depth cannot liquidate the whole proposed position.');
  // Keep top-of-book exits as the same entry protection used by the execution engine.
  if(quantity>0&&bids.filter(p=>Math.abs(p.price-bid)<EPS).reduce((s,p)=>s+p.quantity,0)+EPS<quantity)
    add('reject','EXIT_TOP_DEPTH','The full position is not available at the displayed best bid.');
  const sorted=input.history.filter(p=>{
    if(p.time>input.bookReceivedAt){metrics.ignoredFutureSamples++;return false;}
    return p.time>=input.bookReceivedAt-thresholds.baselineWindowMs;
  }).sort((a,b)=>a.time-b.time);
  const points:Required<OpportunityPoint>[]=[];
  for(const p of sorted){
    if(!Number.isFinite(p.time)||![p.bid,p.ask].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<1)||p.bid!>p.ask!){
      add('wait','HISTORY_QUOTES','Executable bid and ask history is incomplete.');return finish();
    }
    const previous=points.at(-1);
    if(previous?.time===p.time){metrics.duplicateSamples++;if(previous.bid!==p.bid||previous.ask!==p.ask){add('reject','HISTORY_CONFLICT','Conflicting quotes share a timestamp.');return finish();}continue;}
    points.push({time:p.time,price:(p.bid!+p.ask!)/2,bid:p.bid!,ask:p.ask!});
  }
  const last=points.at(-1);
  if(last?.time===input.bookReceivedAt){
    if(Math.abs(last.bid-bid)>EPS||Math.abs(last.ask-ask)>EPS){add('reject','HISTORY_CONFLICT','Current depth conflicts with the recorded quote at this timestamp.');return finish();}
  } else points.push({time:input.bookReceivedAt,price:mid,bid,ask});
  metrics.samples=points.length;metrics.historyMs=points.at(-1)!.time-points[0].time;
  if(points.length<thresholds.minSamples||metrics.historyMs<thresholds.minimumHistoryMs){add('wait','HISTORY_WARMUP',`Collecting executable history (${points.length}/${thresholds.minSamples} quotes; ${(metrics.historyMs/1000).toFixed(0)}/${thresholds.minimumHistoryMs/1000}s).`);return finish();}
  if(points.slice(1).some((p,i)=>p.time-points[i].time>thresholds.maximumGapMs))add('wait','HISTORY_GAP','Quote history has a gap over 15 seconds; fresh continuous evidence is required.');
  // Maximum drawdown scan is causal; tie peaks advance to the last baseline quote.
  let peak=0,trough=0,peakAtDrop=0,drop=0;
  for(let i=1;i<points.length;i++){
    if(points[i].price>=points[peak].price-EPS)peak=i;
    const drawdown=points[peak].price-points[i].price;
    if(drawdown>drop+EPS){drop=drawdown;peakAtDrop=peak;trough=i;}
  }
  if(drop<=EPS){add('wait','NO_DISLOCATION','There is no observed price dislocation to recover.');return finish();}
  const baseline=points.slice(0,peakAtDrop+1),anchor=points[peakAtDrop],bottom=points[trough];
  const dropSeconds=(bottom.time-anchor.time)/1000;
  const baselineIntervals=baseline.slice(1).map((p,i)=>({dt:(p.time-baseline[i].time)/1000,mid:p.price-baseline[i].price,bid:p.bid-baseline[i].bid}));
  const cadence=median(baselineIntervals.map(p=>p.dt))||1;
  const quantizationFloor=tick/Math.sqrt(thresholds.quantizationVarianceDivisor*cadence);
  const robustSigma=(field:'mid'|'bid')=>{
    const rates=baselineIntervals.map(p=>p[field]/Math.sqrt(p.dt));
    const center=median(rates),mad=1.4826*median(rates.map(v=>Math.abs(v-center)));
    const cap=Math.max(thresholds.volatilityClipMadMultiples*mad,2*tick/Math.sqrt(cadence));
    if(rates.some(v=>Math.abs(v)>cap))metrics.volatilityWasClipped=true;
    return Math.sqrt(Math.max(quantizationFloor**2,rates.reduce((s,v)=>s+Math.min(v*v,cap*cap),0)/Math.max(1,rates.length)));
  };
  const sigma=Math.max(robustSigma('mid'),robustSigma('bid'));
  const dropSigma=drop/Math.max(tick,sigma*Math.sqrt(dropSeconds));
  const recovery=points.slice(trough),recoverySeconds=(input.bookReceivedAt-bottom.time)/1000;
  const bidRecovery=bid-bottom.bid,recoveryMagnitude=mid-bottom.price,drift=recoverySeconds>0?bidRecovery/recoverySeconds:0;
  const recoveryVariance=recovery.slice(1).reduce((sum,p,i)=>{const dt=(p.time-recovery[i].time)/1000;return sum+(p.bid-recovery[i].bid-drift*dt)**2/dt;},0)/Math.max(1,recovery.length-2);
  // Baseline diffusion and actual recovery residual noise both constrain the drift.
  const driftSE=recoverySeconds>0?Math.max(sigma,Math.sqrt(recoveryVariance))/Math.sqrt(recoverySeconds):sigma;
  const lowerDrift=drift-thresholds.uncertaintyMultiplier*driftSE;
  const positives=recovery.slice(1).filter((p,i)=>p.bid>recovery[i].bid+EPS).length;
  Object.assign(metrics,{baselineSamples:baseline.length,baselineTime:anchor.time,troughTime:bottom.time,baselineMid:anchor.price,
    referenceBid:anchor.bid,troughMid:bottom.price,troughBid:bottom.bid,dropMagnitude:drop,dropDurationMs:dropSeconds*1000,
    dropSpeedPerSecond:drop/dropSeconds,dropSigma,volatilityPerSqrtSecond:sigma,quantizationFloorPerSqrtSecond:quantizationFloor,
    recoveryMagnitude,bidRecoveryMagnitude:bidRecovery,recoveryFraction:recoveryMagnitude/drop,recoveryDurationMs:recoverySeconds*1000,
    recoverySamples:recovery.length,positiveBidChanges:positives,recoveryDriftPerSecond:drift,driftStandardErrorPerSecond:driftSE,
    recoveryDriftLowerPerSecond:lowerDrift});
  if(baseline.length<thresholds.minimumBaselineSamples)add('wait','BASELINE_THIN','At least six quotes before the drop are needed to estimate its normal noise.');
  if(dropSigma<thresholds.minimumDropSigma)add('wait','MOVE_WITHIN_NOISE','The drop is not distinct from time-adjusted baseline volatility.');
  if(recovery.length-1<thresholds.minimumRecoveryIntervals||positives<thresholds.minimumPositiveBidChanges)
    add('wait','BUYER_CONFIRMATION','Waiting for two independent advances in executable buyers after the trough.');
  if(bidRecovery<=0||lowerDrift<=0)add('wait','RECOVERY_UNCERTAIN','Executable buyer recovery does not exceed its estimated drift uncertainty.');
  // Extrapolate no further than the observed move/recovery duration or the holding cap.
  const horizonMs=Math.min(thresholds.maxHoldMs,Math.max(1000,dropSeconds*1000,recoverySeconds*1000));
  const horizonSeconds=horizonMs/1000,uncertainty=thresholds.uncertaintyMultiplier*driftSE*horizonSeconds;
  const delayFriction=thresholds.uncertaintyMultiplier*sigma*Math.sqrt(input.executionDelayMs/1000);
  const lowerMove=Math.min(anchor.bid-bid,lowerDrift*horizonSeconds);
  const roundTrip=metrics.roundTripCostPerShare;
  const friction=roundTrip===null?null:roundTrip+delayFriction+adverseBookShift;
  let netHeadroom:number|null=null;
  if(quantity>0&&metrics.fullEntryDepth&&metrics.fullExitDepth){
    try{
      const qty=toUnits(quantity),coefficient=toUnits(input.market.feeCoefficient);
      const netAt=(price:number)=>{
        const rounded=money(Math.floor((price+EPS)/tick)*tick);
        if(rounded<=0||rounded>=1)throw new RangeError('Scenario price is outside the binary market.');
        const fees=fromUnits(feeUnits(qty,toUnits(rounded),coefficient));
        return {bid:rounded,fees,net:(fromUnits(notionalUnits(qty,toUnits(rounded)))-fees-cost)/quantity};
      };
      const reference=netAt(anchor.bid-(metrics.exitSlippagePerShare??0));
      metrics.referenceScenarioNetPerShare=reference.net;
      // Future depth is unknown: shift the current liquidation VWAP by the move
      // envelope, retain its measured slippage and recompute nonlinear exit fees.
      const modeled=netAt(bid+lowerMove-(metrics.exitSlippagePerShare??0));
      metrics.modeledExitFees=modeled.fees;metrics.modeledExitBid=modeled.bid;
      netHeadroom=Math.min(modeled.net,reference.net)-delayFriction-adverseBookShift;
    }catch{add('reject','FEE_RULES','The fee-aware price scenarios cannot be computed from these market rules.');}
  }
  const structuralRisk=Math.max(tick,bid-bottom.bid+delayFriction);
  Object.assign(metrics,{horizonMs,uncertaintyPerShare:uncertainty,delayFrictionPerShare:delayFriction,
    frictionPerShare:friction,lowerMovePerShare:lowerMove,netHeadroomPerShare:netHeadroom,
    netHeadroom:netHeadroom===null?null:netHeadroom*quantity,riskPerShare:structuralRisk,
    netRewardRiskRatio:netHeadroom===null?null:netHeadroom/structuralRisk});
  if(anchor.bid<=bid+EPS)add('reject','MOVE_EXHAUSTED','The executable bid has already reached the pre-drop reference; no recovery headroom remains.');
  if(lowerDrift>0&&positives>=thresholds.minimumPositiveBidChanges&&netHeadroom!==null&&netHeadroom<tick*thresholds.minimumNetTickMultiples-EPS)
    add('reject','FRICTION_DOMINATES','The conservative move envelope does not cover spread, depth, fees, delay noise and one price tick.');
  else if(lowerDrift>0&&positives>=thresholds.minimumPositiveBidChanges&&netHeadroom!==null&&netHeadroom/structuralRisk<thresholds.minimumNetRewardRiskRatio-EPS)
    add('wait','RISK_REWARD','Net headroom does not yet cover the distance back to the trough plus delay noise.');
  return finish({quantity,cost,limitPrice:ask,referenceBid:anchor.bid,troughBid:bottom.bid,
    riskPrice:Math.max(tick,bottom.bid-delayFriction),volatilityPerSqrtSecond:sigma,horizonMs,
    netHeadroom:(netHeadroom??0)*quantity,frictionPerShare:friction??0});
}
