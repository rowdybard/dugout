import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeOpportunity,type OpportunityInput,type OpportunityPoint} from '../lib/tennis/opportunity.ts';

const NOW=1_000_000;
const q=(seconds:number,bid:number,spread=.01):OpportunityPoint=>({time:NOW+seconds*1000,price:bid+spread/2,bid,ask:Number((bid+spread).toFixed(6))});
function usefulInput():OpportunityInput {
  const history=[...[-60,-57,-54,-51,-48,-45,-42].map(t=>q(t,.89)),q(-36,.85),q(-30,.81),q(-24,.77),q(-18,.73),q(-12,.69),q(-8,.71),q(-4,.73),q(0,.75)];
  return {history,book:{bids:[{price:.75,quantity:100}],asks:[{price:.76,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(NOW).toISOString()},
    market:{slug:'local-analysis-test',league:'ATP',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695},
    side:'YES',now:NOW,bookReceivedAt:NOW,bookSource:'REST',budget:10,cash:100,executionDelayMs:1000,baselineWindowMs:60_000};
}
test('a slow dislocation and faster executable recovery can enter after actual rounded costs and uncertainty',()=>{
  const input=usefulInput(),original=structuredClone(input),analysis=analyzeOpportunity(input);
  assert.equal(analysis.decision,'enter',JSON.stringify(analysis));
  assert.ok(analysis.entry);assert.ok(analysis.metrics.dropSigma!>=analysis.thresholds.minimumDropSigma);
  assert.ok(analysis.metrics.netHeadroomPerShare!>=input.market.priceIncrement);
  assert.ok(analysis.metrics.netRewardRiskRatio!>=1);assert.ok(analysis.metrics.entryFees!>0);
  assert.equal(analysis.metrics.entrySlippagePerShare,0);assert.equal(analysis.metrics.fullExitDepth,true);
  assert.equal(analysis.metrics.baselineSamples,7);assert.equal(analysis.metrics.dropDurationMs,30_000);
  assert.equal(analysis.entry.referenceBid,.89);assert.deepEqual(input,original);
  assert.deepEqual(JSON.parse(JSON.stringify(analysis)),analysis);
});
test('midpoint recovery caused only by ask changes cannot masquerade as executable buyer recovery',()=>{
  const input=usefulInput();input.history=input.history.slice(0,-3).concat(q(-8,.69,.012),q(-4,.69,.016),q(0,.69,.02));
  input.book.bids[0].price=.69;input.book.asks[0].price=.71;input.market.priceIncrement=.001;
  const analysis=analyzeOpportunity(input);
  assert.notEqual(analysis.decision,'enter');assert.equal(analysis.metrics.bidRecoveryMagnitude,0);
  assert.ok(analysis.metrics.recoveryMagnitude!>0);assert.ok(analysis.reasons.some(r=>r.code==='RECOVERY_UNCERTAIN'));
});
test('the same cent drop receives a smaller dislocation statistic in a volatile baseline',()=>{
  const calm=usefulInput(),noisy=usefulInput();
  noisy.history=noisy.history.map((point,i)=>i<7?q((point.time-NOW)/1000,i%2?.80:.89):point);
  const a=analyzeOpportunity(calm),b=analyzeOpportunity(noisy);
  assert.equal(a.metrics.dropMagnitude,b.metrics.dropMagnitude);
  assert.ok(b.metrics.volatilityPerSqrtSecond!>a.metrics.volatilityPerSqrtSecond!);
  assert.ok(b.metrics.dropSigma!<a.metrics.dropSigma!);assert.notEqual(b.decision,'enter');
  assert.ok(b.reasons.some(r=>r.code==='MOVE_WITHIN_NOISE'));
});
test('raising real simulated fees consumes headroom without changing the observed move',()=>{
  const low=usefulInput(),high=usefulInput();high.market.feeCoefficient=.5;
  const a=analyzeOpportunity(low),b=analyzeOpportunity(high);
  assert.equal(a.decision,'enter');assert.equal(a.metrics.dropMagnitude,b.metrics.dropMagnitude);
  assert.equal(b.decision,'reject');assert.ok(b.metrics.roundTripCostPerShare!>a.metrics.roundTripCostPerShare!);
  assert.ok(b.reasons.some(r=>r.code==='FRICTION_DOMINATES'));
});
test('insufficient ask depth or exit depth rejects the full proposed amount',()=>{
  for(const side of ['bids','asks'] as const){const input=usefulInput();input.book[side][0].quantity=1;
    const a=analyzeOpportunity(input);assert.equal(a.decision,'reject');
    assert.ok(a.reasons.some(r=>r.code===(side==='asks'?'ENTRY_DEPTH':'EXIT_DEPTH')));
  }
});
test('deeper bid prices are charged as slippage and cannot bypass the best-bid depth protection',()=>{
  const input=usefulInput();input.book.bids=[{price:.75,quantity:1},{price:.73,quantity:100}];input.history=input.history.slice(0,-1);
  const a=analyzeOpportunity(input);
  assert.equal(a.decision,'reject');assert.equal(a.metrics.fullExitDepth,true);
  assert.ok(a.metrics.exitSlippagePerShare!>0);assert.ok(a.reasons.some(r=>r.code==='EXIT_TOP_DEPTH'));
});
test('outcome normalization produces identical evidence for equivalent NO and YES contracts',()=>{
  const yes=usefulInput(),no=usefulInput();no.side='NO';
  no.book.bids=yes.book.asks.map(p=>({price:Number((1-p.price).toFixed(6)),quantity:p.quantity}));
  no.book.asks=yes.book.bids.map(p=>({price:Number((1-p.price).toFixed(6)),quantity:p.quantity}));
  assert.deepEqual(analyzeOpportunity(no),analyzeOpportunity(yes));
});
test('reordered snapshots and identical timestamp duplicates do not fabricate independent evidence',()=>{
  const input=usefulInput(),reordered=usefulInput();
  reordered.history=[...reordered.history].reverse().concat(reordered.history[0]);
  const a=analyzeOpportunity(input),b=analyzeOpportunity(reordered);
  assert.equal(b.metrics.duplicateSamples,1);b.metrics.duplicateSamples=0;assert.deepEqual(a,b);
  const conflict=usefulInput();conflict.history=[...conflict.history,q(-60,.78)];
  assert.equal(analyzeOpportunity(conflict).code,'HISTORY_CONFLICT');
});
test('future observations are excluded and cannot strengthen a present signal',()=>{
  const input=usefulInput(),future=usefulInput();future.history=[...future.history,q(10,.99)];
  const a=analyzeOpportunity(input),b=analyzeOpportunity(future);
  assert.equal(b.metrics.ignoredFutureSamples,1);b.metrics.ignoredFutureSamples=0;assert.deepEqual(a,b);
});
test('volatility scales with irregular timestamps rather than with quote count',()=>{
  const regular=usefulInput(),irregular=usefulInput();
  irregular.history=irregular.history.map((p,i)=>i<7?{...p,time:NOW+[-60,-59,-58,-54,-50,-45,-42][i]*1000}:p);
  const a=analyzeOpportunity(regular),b=analyzeOpportunity(irregular);
  assert.equal(a.metrics.dropMagnitude,b.metrics.dropMagnitude);
  assert.notEqual(a.metrics.volatilityPerSqrtSecond,b.metrics.volatilityPerSqrtSecond);
  assert.equal(b.metrics.historyMs,60_000);assert.ok(Number.isFinite(b.metrics.recoveryDriftLowerPerSecond));
});
test('long gaps, insufficient history, stale books and wider spreads abstain without relaxing protections',()=>{
  const gap=usefulInput();gap.history=gap.history.filter(p=>p.time<NOW-40_000||p.time>NOW-15_000);
  assert.notEqual(analyzeOpportunity(gap).decision,'enter');
  assert.ok(analyzeOpportunity(gap).reasons.some(r=>r.code==='HISTORY_GAP'));
  const thin=usefulInput();thin.history=thin.history.slice(-5);assert.equal(analyzeOpportunity(thin).code,'HISTORY_WARMUP');
  const stale=usefulInput();stale.now+=5001;stale.maxBookAgeMs=30000;assert.equal(analyzeOpportunity(stale).code,'BOOK_STALE');
  const wide=usefulInput();wide.book.asks[0].price=.78;wide.history=wide.history.slice(0,-1);wide.maxSpreadPoints=10;
  assert.equal(analyzeOpportunity(wide).code,'SPREAD');assert.equal(analyzeOpportunity(wide).thresholds.maximumSpread,.02);
});
test('cash rejection retains the movement diagnostics needed for held-position analysis',()=>{
  const input=usefulInput();input.cash=0;const analysis=analyzeOpportunity(input);
  assert.equal(analysis.decision,'reject');assert.equal(analysis.code,'ENTRY_DEPTH');
  assert.ok(analysis.metrics.volatilityPerSqrtSecond!>0);assert.ok(analysis.metrics.recoveryDriftPerSecond!>0);
});
test('adverse displayed depth consumes headroom as a microprice stress, never as a probability score',()=>{
  const neutral=usefulInput(),adverse=usefulInput();adverse.book.asks[0].quantity=1000;
  const a=analyzeOpportunity(neutral),b=analyzeOpportunity(adverse);
  assert.ok(b.metrics.imbalance!<0);assert.ok(b.metrics.adverseBookShift!>0);
  assert.ok(b.metrics.netHeadroomPerShare!<a.metrics.netHeadroomPerShare!);
  assert.equal(Object.hasOwn(b,'probability'),false);
});
test('forward scenarios recompute nonlinear exit fees instead of reusing cheaper current fees',()=>{
  const input=usefulInput();input.history=input.history.map(p=>({...p,price:Number((p.price-.5).toFixed(6)),bid:Number((p.bid!-.5).toFixed(6)),ask:Number((p.ask!-.5).toFixed(6))}));
  input.book.bids[0].price=.25;input.book.asks[0].price=.26;
  const analysis=analyzeOpportunity(input);
  assert.ok(analysis.metrics.modeledExitBid!>.25);assert.ok(analysis.metrics.modeledExitFees!>analysis.metrics.exitFees!);
  assert.ok(analysis.metrics.netHeadroomPerShare!<analysis.metrics.referenceScenarioNetPerShare!);
});
test('non-finite inputs reject with JSON-safe diagnostics',()=>{
  const input=usefulInput();input.minimumHistoryMs=NaN;const analysis=analyzeOpportunity(input);
  assert.equal(analysis.decision,'reject');assert.deepEqual(JSON.parse(JSON.stringify(analysis)),analysis);
});
