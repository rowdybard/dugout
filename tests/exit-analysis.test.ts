import test from 'node:test';
import assert from 'node:assert/strict';
import {assessAdaptiveExit,createExitPlan,measureExitMarket,type AdaptiveExitInput,type AdaptiveExitPlan,type AdaptiveExitState,type ExitMarketPoint} from '../lib/tennis/exit-analysis.ts';
import {executePaperCommand} from '../lib/trading/execution.ts';

const epoch=1_000_000;
function plan(overrides:Partial<AdaptiveExitPlan>={}):AdaptiveExitPlan{
  return createExitPlan({openedAt:epoch,entryAllInUnitCost:.52,
    risk:{targetReturn:.03,stopReturn:.08,maxHoldMs:120_000},
    thesis:{referenceBid:.65,riskPrice:.47,volatilityPerSqrtSecond:.002,horizonMs:60_000,frictionPerShare:.02},
    executionDelayMs:1_000,tickSize:.001,...overrides});
}
function sample(overrides:Partial<AdaptiveExitInput>={},bid=.55,quantity=10,bidDepth=10):AdaptiveExitInput{
  const now=overrides.now??epoch+5_000;
  const execution=executePaperCommand({commandId:'mark',marketSlug:'synthetic',side:'YES',action:'SELL',source:'MANUAL',
    quantity,limitPrice:bid,createdAt:now},
  {cash:90,marketExposure:.52*quantity,totalExposure:.52*quantity,availableQuantity:quantity},
  {slug:'synthetic',league:'ATP',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.001,feeCoefficient:.02},
  {bids:[{price:bid,quantity:bidDepth}],asks:[{price:bid+.001,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(now).toISOString()},
  {now,bookReceivedAt:now,bookSource:'REST',stateCertain:true,maxBookAgeMs:5_000,maxCommandAgeMs:30_000,maxOrderBudget:25,
    maxMarketExposure:25,maxTotalExposure:25,automation:'PAPER'});
  assert.ok(execution.apply,'Fixture must have executable exit depth.');
  return {plan:plan(),now,maxBookAgeMs:5_000,
    mark:{bookTime:now,netLiquidationValue:execution.cashDelta,liquidationQuantity:execution.filledQty,remainingQuantity:quantity,remainingCostBasis:.52*quantity},
    market:{bid,ask:bid+.001,volatilityPerSqrtSecond:.002,recoveryDriftLowerPerSecond:.001,imbalance:.2,feeCoefficient:.02},...overrides};
}
function nextState(state:AdaptiveExitState,bid:number,offset:number,overrides:Partial<AdaptiveExitInput>={}){
  return assessAdaptiveExit(sample({priorState:state,now:epoch+offset,...overrides},bid));
}

test('adaptive exits use net executable fees and can hold past the legacy fixed target',()=>{
  const input=sample(),result=assessAdaptiveExit(input);
  assert.equal(result.action,'hold');
  assert.equal(result.code,'ADAPTIVE_HOLD');
  assert.equal(result.metrics.netReturn,5.45/5.2-1);
  assert.ok(result.metrics.netReturn!>input.plan.risk.targetReturn);
  assert.equal(result.metrics.referenceNetReturn,6.45/5.2-1);
  assert.equal(result.metrics.remainingHeadroomReturn,result.metrics.referenceNetReturn!-result.metrics.netReturn!);
  assert.ok(result.metrics.continuationRiskReturn!<result.metrics.remainingHeadroomReturn!);
});

test('fees below break-even cannot be described as profitable exhaustion',()=>{
  const input=sample({},.523);
  input.plan.thesis.referenceBid=.523;
  const result=assessAdaptiveExit(input);
  assert.ok(input.market.bid>input.plan.entryAllInUnitCost);
  assert.ok(result.metrics.netReturn!<0);
  assert.equal(result.action,'hold');
  assert.equal(result.state.evidence.kind,null);
});

test('a genuine net peak protects its gain after a volatility-adjusted reversal',()=>{
  const first=assessAdaptiveExit(sample());
  assert.ok(first.state.trailingFloorReturn>0);
  const withinNoise=nextState(first.state,.548,6_000);
  assert.equal(withinNoise.action,'hold');
  const reversal=nextState(withinNoise.state,.54,7_000);
  assert.equal(reversal.action,'exit');
  assert.equal(reversal.code,'VOLATILITY_TRAIL');
  assert.ok(reversal.metrics.netReturn!>0);
});

test('higher later volatility cannot lower an already ratcheted profit floor',()=>{
  const first=assessAdaptiveExit(sample());
  const update=sample({priorState:first.state,now:epoch+6_000},.549);
  update.market.volatilityPerSqrtSecond=.1;
  const result=assessAdaptiveExit(update);
  assert.equal(result.state.trailingFloorReturn,first.state.trailingFloorReturn);
  assert.equal(result.action,'hold');
});

test('wider spread expands the initial noise buffer but never loosens an existing floor',()=>{
  const narrow=assessAdaptiveExit(sample());
  const initialWide=sample();initialWide.market.ask=.59;
  const wide=assessAdaptiveExit(initialWide);
  assert.ok(wide.metrics.noiseBufferReturn!>narrow.metrics.noiseBufferReturn!);
  assert.ok(wide.state.trailingFloorReturn<narrow.state.trailingFloorReturn);
  const later=sample({priorState:narrow.state,now:epoch+6_000});later.market.ask=.59;
  assert.equal(assessAdaptiveExit(later).state.trailingFloorReturn,narrow.state.trailingFloorReturn);
});

test('partial depth cannot manufacture a full-position peak or profit-taking decision',()=>{
  const input=sample({},.65,10,2);
  input.plan.thesis.referenceBid=.65;
  let result=assessAdaptiveExit(input);
  assert.equal(result.metrics.liquidityFraction,.2);
  assert.equal(result.metrics.completeMark,false);
  assert.equal(result.state.highWaterNetReturn,null);
  assert.equal(result.state.trailingFloorReturn,-.08);
  result=assessAdaptiveExit({...input,now:epoch+6_000,priorState:result.state,mark:{...input.mark,bookTime:epoch+6_000}});
  assert.equal(result.action,'hold');assert.equal(result.state.evidence.kind,null);
});

test('partial executable depth still triggers original stop using its allocated cost and exact fees',()=>{
  const result=assessAdaptiveExit(sample({},.48,10,2));
  assert.equal(result.metrics.netReturn,.95/1.04-1);
  assert.equal(result.code,'HARD_STOP');assert.equal(result.action,'exit');
  assert.equal(result.state.highWaterNetReturn,null);
});

test('original stop and maximum holding time do not depend on analysis or game context',()=>{
  const stopped=sample({},.48);
  stopped.market.volatilityPerSqrtSecond=NaN;
  assert.equal(assessAdaptiveExit(stopped).code,'HARD_STOP');
  const expired=sample({now:epoch+120_000},.52);
  expired.market.recoveryDriftLowerPerSecond=NaN;
  const result=assessAdaptiveExit(expired);
  assert.equal(result.code,'MAX_HOLD');assert.equal(result.action,'exit');
});

test('stale, future, out-of-order and pre-entry marks cannot update the executable peak',()=>{
  const first=assessAdaptiveExit(sample());
  for(const bookTime of [epoch-1,epoch+4_999,epoch+20_000,epoch+6_000]){
    const input=sample({priorState:first.state,now:epoch+12_000},.7);
    input.mark.bookTime=bookTime;
    const result=assessAdaptiveExit(input);
    assert.equal(result.action,'hold');assert.equal(result.code,'STALE_EXIT_MARK');
    assert.deepEqual(result.state,first.state);
  }
});

test('raising configured freshness above five seconds does not accept older marks',()=>{
  const input=sample({maxBookAgeMs:60_000});input.mark.bookTime=epoch-1;
  assert.equal(assessAdaptiveExit(input).code,'STALE_EXIT_MARK');
  input.now=epoch+12_000;input.mark.bookTime=epoch+6_000;
  assert.equal(assessAdaptiveExit(input).code,'STALE_EXIT_MARK');
});

test('duplicate receipts cannot manufacture evidence or peaks, including altered duplicate payloads',()=>{
  const input=sample({},.64);input.plan.thesis.referenceBid=.64;
  const first=assessAdaptiveExit(input);
  assert.equal(first.state.evidence.samples,1);
  const duplicated=assessAdaptiveExit({...input,now:input.now+500,priorState:first.state,
    mark:{...input.mark,netLiquidationValue:input.mark.netLiquidationValue!+.01}});
  assert.equal(duplicated.code,'UNCHANGED_EXIT_BOOK');
  assert.deepEqual(duplicated.state,first.state);
});

test('exhausted fee-adjusted recovery headroom exits below any fixed target only after fresh confirmation',()=>{
  const frozen=plan({risk:{targetReturn:.5,stopReturn:.08,maxHoldMs:120_000}});
  frozen.thesis.referenceBid=.55;
  const first=assessAdaptiveExit(sample({plan:frozen}));
  assert.equal(first.action,'hold');assert.equal(first.code,'EXIT_EVIDENCE_FORMING');
  const tooEarly=nextState(first.state,.55,5_500,{plan:frozen});
  assert.equal(tooEarly.action,'hold');
  const confirmed=nextState(tooEarly.state,.55,6_000,{plan:frozen});
  assert.equal(confirmed.action,'exit');assert.equal(confirmed.code,'OPPORTUNITY_DECAY');
  assert.ok(confirmed.metrics.netReturn!<frozen.risk.targetReturn);
});

test('transient adverse evidence clears and must restart instead of flapping into an exit',()=>{
  const frozen=plan();frozen.thesis.riskPrice=.53;
  const first=assessAdaptiveExit(sample({plan:frozen},.52));
  assert.equal(first.state.evidence.kind,'THESIS_INVALID');
  const recovered=nextState(first.state,.528,6_000,{plan:frozen});
  assert.equal(recovered.state.evidence.kind,null);
  const initialAgain=nextState(recovered.state,.52,7_000,{plan:frozen});
  assert.equal(initialAgain.action,'hold');
  assert.equal(initialAgain.state.evidence.samples,1);
  const confirmed=nextState(initialAgain.state,.52,8_000,{plan:frozen});
  assert.equal(confirmed.code,'THESIS_INVALID');assert.equal(confirmed.action,'exit');
  assert.ok(confirmed.metrics.netReturn!>-.08);
});

test('a long data gap restarts thesis confirmation even if the new receipt is fresh',()=>{
  const frozen=plan();frozen.thesis.riskPrice=.53;
  const first=assessAdaptiveExit(sample({plan:frozen},.52));
  const resumed=nextState(first.state,.52,20_000,{plan:frozen});
  assert.equal(resumed.action,'hold');assert.equal(resumed.state.evidence.samples,1);
  assert.equal(resumed.state.evidence.since,epoch+20_000);
});

test('an expired weak recovery exits only with executable net profit and two fresh books',()=>{
  const frozen=plan();frozen.thesis.horizonMs=10_000;
  const input=sample({plan:frozen,now:epoch+10_000});
  input.market.recoveryDriftLowerPerSecond=-.001;input.market.imbalance=-.5;
  const first=assessAdaptiveExit(input);
  assert.equal(first.state.evidence.kind,'OPPORTUNITY_DECAY');
  const second=assessAdaptiveExit({...input,now:epoch+11_000,priorState:first.state,mark:{...input.mark,bookTime:epoch+11_000}});
  assert.equal(second.action,'exit');assert.equal(second.code,'OPPORTUNITY_DECAY');
  assert.match(second.reason,/horizon/);
});

test('adverse measured drift and imbalance increase waiting risk in logged units',()=>{
  const input=sample();
  const base=assessAdaptiveExit(input);
  input.market.recoveryDriftLowerPerSecond=-.003;input.market.imbalance=-1;
  const adverse=assessAdaptiveExit(input);
  const increment=(.003+.001/2)/.52;
  assert.ok(Math.abs(adverse.metrics.continuationRiskReturn!-base.metrics.continuationRiskReturn!-increment)<1e-10);
});

test('an issued exit stays latched after price recovers and serialization round-trips',()=>{
  const exit=assessAdaptiveExit(sample({},.48));
  const recovered=nextState(JSON.parse(JSON.stringify(exit.state)),.65,6_000);
  assert.equal(recovered.action,'exit');assert.equal(recovered.code,'HARD_STOP');
  assert.deepEqual(JSON.parse(JSON.stringify(recovered)),recovered);
});

test('the entry plan is a detached snapshot, validates numbers and caps its soft horizon',()=>{
  const source={openedAt:epoch,entryAllInUnitCost:.52,risk:{targetReturn:.03,stopReturn:.08,maxHoldMs:120_000},
    thesis:{referenceBid:.65,riskPrice:.47,volatilityPerSqrtSecond:.002,horizonMs:600_000,frictionPerShare:.02},executionDelayMs:1_000,tickSize:.001};
  const frozen=createExitPlan(source);
  source.risk.stopReturn=.4;source.risk.maxHoldMs=600_000;
  assert.equal(frozen.risk.stopReturn,.08);assert.equal(frozen.risk.maxHoldMs,120_000);assert.equal(frozen.thesis.horizonMs,120_000);
  assert.throws(()=>createExitPlan({...source,entryAllInUnitCost:NaN}),RangeError);
});

test('invalid books and absent depth cannot manufacture liquidations or mutate monetary state',()=>{
  const input=sample();const before=structuredClone(input);
  const result=assessAdaptiveExit(input);
  assert.deepEqual(input,before);assert.equal(result.action,'hold');
  for(const invalid of [null,NaN,-1]){
    input.mark.netLiquidationValue=invalid;
    assert.equal(assessAdaptiveExit(input).code,'NO_EXIT_DEPTH');
  }
});

test('a saved floor below original stop is clamped without relaxing the entry risk',()=>{
  const first=assessAdaptiveExit(sample({},.52));
  first.state.trailingFloorReturn=-.9;
  const result=nextState(first.state,.52,6_000);
  assert.equal(result.state.trailingFloorReturn,-.08);
});

function heldHistory(bids:number[],offsets=bids.map((_,i)=>i*1_000)):ExitMarketPoint[]{
  return bids.map((bid,i)=>({time:epoch+offsets[i],bid,ask:bid+.002,price:bid+.001}));
}

test('held-side measurements use recent executable changes even without a recovery pattern',()=>{
  const history=heldHistory([.6,.59,.58,.57,.56]);
  const measurement=measureExitMarket(history,epoch+4_000,30_000);
  assert.equal(measurement.available,true);assert.equal(measurement.samples,5);
  assert.ok(Math.abs(measurement.driftPerSecond!+.01)<1e-10);
  assert.ok(measurement.volatilityPerSqrtSecond!<1e-10);
  assert.ok(measurement.recoveryDriftLowerPerSecond!<0);
});

test('irregular quote cadence scales drift and diffusion by elapsed time',()=>{
  const history=heldHistory([.5,.504,.502,.507],[0,1_000,3_000,6_000]);
  const measurement=measureExitMarket(history,epoch+6_000,30_000);
  const slope=.007/6;
  const variance=((.004-slope)**2+(-.002-slope*2)**2/2+(.005-slope*3)**2/3)/2;
  assert.ok(Math.abs(measurement.driftPerSecond!-slope)<1e-10);
  assert.ok(Math.abs(measurement.volatilityPerSqrtSecond!-Math.sqrt(variance))<1e-10);
  const scaled=measureExitMarket(heldHistory([.5,.504,.502,.507],[0,2_000,6_000,12_000]),epoch+12_000,30_000);
  assert.ok(Math.abs(scaled.driftPerSecond!-slope/2)<1e-10);
  assert.ok(Math.abs(scaled.volatilityPerSqrtSecond!-measurement.volatilityPerSqrtSecond!/Math.sqrt(2))<1e-10);
});

test('current noisy bid reversals increase held volatility independently of old baseline',()=>{
  const smooth=measureExitMarket(heldHistory([.55,.551,.552,.553,.554]),epoch+4_000,30_000);
  const noisy=measureExitMarket(heldHistory([.55,.561,.542,.563,.554]),epoch+4_000,30_000);
  assert.ok(noisy.volatilityPerSqrtSecond!>smooth.volatilityPerSqrtSecond!);
  assert.ok(noisy.recoveryDriftLowerPerSecond!<0);
  assert.ok(smooth.recoveryDriftLowerPerSecond!>0);
});

test('held history is causal, order-normalized and duplicate-insensitive without mutation',()=>{
  const history=heldHistory([.5,.51,.505,.512]);const before=structuredClone(history);
  const expected=measureExitMarket(history,epoch+3_000,30_000);
  const replayed=measureExitMarket([...history].reverse().concat(history[1],{time:epoch+4_000,bid:.99,ask:.999,price:.995}),epoch+3_000,30_000);
  assert.deepEqual(replayed,expected);assert.deepEqual(history,before);
  const conflict=measureExitMarket([...history,{...history[1],bid:.505}],epoch+3_000,30_000);
  assert.equal(conflict.available,false);assert.equal(conflict.code,'EXIT_HISTORY_CONFLICT');
});

test('held history rejects sparse, stale, gapped, conflicting and missing executable evidence',()=>{
  assert.equal(measureExitMarket(heldHistory([.5,.51,.52]),epoch+2_000,30_000).code,'EXIT_HISTORY_WARMUP');
  assert.equal(measureExitMarket(heldHistory([.5,.51,.52,.53]),epoch+9_000,30_000).code,'EXIT_HISTORY_STALE');
  assert.equal(measureExitMarket(heldHistory([.5,.51,.52,.53],[0,1_000,17_000,18_000]),epoch+18_000,30_000).code,'EXIT_HISTORY_GAP');
  const history=heldHistory([.5,.51,.52,.53]);delete history[1].bid;
  assert.equal(measureExitMarket(history,epoch+3_000,30_000).code,'EXIT_HISTORY_QUOTES');
  assert.equal(measureExitMarket(history,NaN,30_000).code,'EXIT_HISTORY_INPUT');
});

test('a quiet held market has measured zero noise rather than missing invented volatility',()=>{
  const result=measureExitMarket(heldHistory([.5,.5,.5,.5]),epoch+3_000,30_000);
  assert.equal(result.available,true);assert.equal(result.volatilityPerSqrtSecond,0);assert.equal(result.recoveryDriftLowerPerSecond,0);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});

test('unsupported numeric extremes never leak non-finite values to journal metrics',()=>{
  const input=sample();input.market.volatilityPerSqrtSecond=Number.MAX_VALUE;
  const result=assessAdaptiveExit(input);
  assert.equal(result.code,'EXIT_ANALYSIS_UNAVAILABLE');
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});
