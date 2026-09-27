import type {OpportunityAnalysis} from '@/lib/tennis/opportunity';
import type {AdaptiveExitAssessment,AdaptiveExitPlan} from '@/lib/tennis/exit-analysis';

const numeric=(value:number|null|undefined,digits=2,suffix='')=>typeof value==='number'&&Number.isFinite(value)?`${value.toFixed(digits)}${suffix}`:'Not available';
const cents=(value:number|null|undefined)=>numeric(value==null?value:value*100,2,'¢');
const rate=(value:number|null|undefined)=>typeof value==='number'&&Number.isFinite(value)?`${cents(value)}/s`:'Not available';
const percent=(value:number|null|undefined)=>numeric(value==null?value:value*100,1,'%');
const seconds=(value:number|null|undefined)=>numeric(value==null?value:value/1000,1,'s');
const at=(time:number)=>new Date(time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'});
const age=(time:number,now:number)=>`${Math.max(0,Math.floor((now-time)/1000))}s ago`;
type Props={analysis?:OpportunityAnalysis;exitAnalysis?:AdaptiveExitAssessment;plan?:AdaptiveExitPlan;time:number;exitTime?:number;label:string;name:string;now:number};

export function DecisionMetrics({analysis,exitAnalysis,plan,time,exitTime,label,name,now}:Props){
  if(!analysis&&!exitAnalysis&&!plan)return null;
  const metrics=analysis?.metrics,exit=exitAnalysis?.metrics;
  return <details className="tennis-decision-details">
    <summary>Decision details <span>{name}</span></summary>
    <div className="tennis-decision-details-content">
      {analysis&&metrics&&<><p><b>{label}</b> · {at(time)} ({age(time,now)}) · {analysis.decision==='enter'?'Entry candidate':analysis.decision==='wait'?'Waiting for evidence':'Entry rejected'}</p>
        <dl className="tennis-metrics-grid">
          <div><dt>History</dt><dd>{metrics.samples} quotes · {seconds(metrics.historyMs)}</dd></div>
          <div><dt>Drop / noise scale</dt><dd>{cents(metrics.dropMagnitude)} / {numeric(metrics.dropSigma,2,'×')}</dd></div>
          <div><dt>Drop speed</dt><dd>{rate(metrics.dropSpeedPerSecond)}</dd></div>
          <div><dt>Baseline volatility</dt><dd>{cents(metrics.volatilityPerSqrtSecond)}/√s</dd></div>
          <div><dt>Recovered from trough</dt><dd>{cents(metrics.bidRecoveryMagnitude)} · {percent(metrics.recoveryFraction)}</dd></div>
          <div><dt>Lower recovery drift</dt><dd>{rate(metrics.recoveryDriftLowerPerSecond)}</dd></div>
          <div><dt>Buyer / seller depth</dt><dd>{numeric(metrics.bidDepth,1)} / {numeric(metrics.askDepth,1)}</dd></div>
          <div><dt>Depth imbalance</dt><dd>{percent(metrics.imbalance)}</dd></div>
          <div><dt>Spread</dt><dd>{cents(metrics.spread)}</dd></div>
          <div><dt>Round-trip cost / contract</dt><dd>{cents(metrics.roundTripCostPerShare)}</dd></div>
          <div><dt>Entry / current exit fees</dt><dd>{cents(metrics.entryFees)} / {cents(metrics.exitFees)}</dd></div>
          <div><dt>Current exit depth slippage</dt><dd>{cents(metrics.exitSlippagePerShare)} / contract</dd></div>
          <div><dt>Delay-noise allowance</dt><dd>{cents(metrics.delayFrictionPerShare)}</dd></div>
          <div><dt>Net scenario headroom / contract</dt><dd>{cents(metrics.netHeadroomPerShare)}</dd></div>
          <div><dt>Net headroom / structural risk</dt><dd>{numeric(metrics.netRewardRiskRatio,2,'×')}</dd></div>
          <div><dt>Scenario horizon</dt><dd>{seconds(metrics.horizonMs)}</dd></div>
        </dl>
        {analysis.reasons.length>0&&<ul>{analysis.reasons.map((reason,index)=><li key={`${reason.code}:${index}`}>{reason.reason}</li>)}</ul>}
      </>}
      {exitAnalysis&&exit&&<><p><b>Exit check</b>{exitTime!==undefined?` · ${at(exitTime)} (${age(exitTime,now)})`:''} · {exitAnalysis.action==='exit'?'Exit requested':'Holding'}</p><p>{exitAnalysis.reason}</p>
        {exitAnalysis.marketMeasurement&&!exitAnalysis.marketMeasurement.available&&<p>{exitAnalysis.marketMeasurement.reason}</p>}
        <dl className="tennis-metrics-grid">
          <div><dt>Executable net return</dt><dd>{percent(exit.netReturn)}{!exit.completeMark?' · partial depth':''}</dd></div>
          <div><dt>Best complete net mark</dt><dd>{percent(exit.peakNetReturn)}</dd></div>
          <div><dt>Ratcheted exit floor</dt><dd>{percent(exit.trailingFloorReturn)}</dd></div>
          <div><dt>Remaining scenario headroom</dt><dd>{percent(exit.remainingHeadroomReturn)}</dd></div>
          <div><dt>Measured waiting-risk allowance</dt><dd>{percent(exit.continuationRiskReturn)}</dd></div>
          <div><dt>Independent exit evidence</dt><dd>{exit.evidenceSamples} books · {seconds(exit.evidenceAgeMs)}</dd></div>
        </dl>
      </>}
      {plan&&<p>Saved at entry: loss threshold {percent(plan.risk.stopReturn)} · maximum hold {seconds(plan.risk.maxHoldMs)}. A triggered exit still needs a later fresh executable book.</p>}
      <small>Local price-and-depth calculations, not a win probability or a profit forecast. Unavailable measurements are labeled; the reference price is an observed scenario, not a promised destination.</small>
    </div>
  </details>;
}
