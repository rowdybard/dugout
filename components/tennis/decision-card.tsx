import type {FootballAssessment,TennisMarket,TennisRuntime,TennisSession} from '@/lib/tennis/types';
import {decisionView,sideLines} from '@/lib/tennis/decision-view';
import {decisionEvidence} from '@/lib/tennis/decision-evidence';
import {DecisionMetrics} from './decision-metrics';
import {footballFreshnessNotice,isFootballFreshnessReason} from './football-notice';
import type {ContextCheckState} from '@/lib/tennis/context-check';

const age=(value:number|null)=>value===null?'—':value<1000?'now':value<60000?`${Math.floor(value/1000)}s`:`${Math.floor(value/60000)}m`;
export function DecisionCard({session,market,runtime,now,contextAssessment,contextCheck}:{session:TennisSession;market?:TennisMarket;runtime:TennisRuntime|null;now:number;contextAssessment?:FootballAssessment;contextCheck?:ContextCheckState}){
  const view=decisionView(session,market,runtime,now);
  const held=session.positions.find(position=>position.status==='open');
  const evidence=decisionEvidence(session,view.focus,view.side);
  const identity=market?.slug===view.focus?market:held?.slug===view.focus?held.market:
    session.pending?.slug===view.focus?session.pending.market:session.positions.findLast(position=>position.slug===view.focus)?.market;
  const name=evidence?(evidence.side==='YES'?identity?.yesName:identity?.noName)??held?.name??evidence.side:'';
  const active=session.status==='running'||session.status==='stopping'||!!held||!!session.pending;
  const notice=identity&&active?footballFreshnessNotice(identity,now,contextAssessment,contextCheck,view.reason):null;
  const state=notice&&['Watching','Setup forming','Buy offers posted'].includes(view.state)?'Entries waiting':view.state;
  const reason=notice??view.reason;
  const sides=sideLines(session,view.focus,identity).filter(line=>!notice||!isFootballFreshnessReason(line.text));
  return <div className="tennis-decision-card">
    <div className="tennis-decision-head"><strong>{state}</strong><span className="tennis-chips">
      <span title="Last saved bot check">Check {age(view.checkAge)}</span><span title="Last accepted order book">Quote {age(view.quoteAge)}</span>
    </span></div>
    <p role="status" data-football-feed-status={notice?'primary':undefined} className="tennis-clamp tennis-clamp-4" title={reason}>{reason}</p>
    {evidence&&<DecisionMetrics {...evidence} name={name} now={now}/>}
    {view.focus&&!!sides.length&&<details><summary>Both sides</summary>{sides.map(line=><p key={line.side}><b>{line.name}</b>: {line.text}</p>)}</details>}
  </div>;
}
