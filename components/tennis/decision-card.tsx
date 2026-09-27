import type {TennisMarket,TennisRuntime,TennisSession} from '@/lib/tennis/types';
import {decisionView} from '@/lib/tennis/decision-view';
import {decisionEvidence} from '@/lib/tennis/decision-evidence';
import {DecisionMetrics} from './decision-metrics';

const age=(value:number|null)=>value===null?'—':value<1000?'now':value<60000?`${Math.floor(value/1000)}s`:`${Math.floor(value/60000)}m`;
export function DecisionCard({session,market,runtime,now}:{session:TennisSession;market?:TennisMarket;runtime:TennisRuntime|null;now:number}){
  const view=decisionView(session,market,runtime,now);
  const held=session.positions.find(position=>position.status==='open');
  const evidence=decisionEvidence(session,view.focus,view.side);
  const identity=market?.slug===view.focus?market:held?.slug===view.focus?held.market:
    session.pending?.slug===view.focus?session.pending.market:session.positions.findLast(position=>position.slug===view.focus)?.market;
  const name=evidence?(evidence.side==='YES'?identity?.yesName:identity?.noName)??held?.name??evidence.side:'';
  return <div className="tennis-decision-card">
    <div className="tennis-decision-head"><strong>{view.state}</strong><span className="tennis-chips">
      <span title="Last saved bot check">Check {age(view.checkAge)}</span><span title="Last accepted order book">Quote {age(view.quoteAge)}</span>{view.football&&<span title="Last verified game report">Game {age(view.gameAge)}</span>}
    </span></div>
    <p role="status" className="tennis-clamp" title={view.reason}>{view.reason}</p>
    {evidence&&<DecisionMetrics {...evidence} name={name} now={now}/>}
    {view.focus&&<details><summary>Both sides</summary>{(['YES','NO'] as const).map(side=>{const latest=session.decisions.findLast(row=>row.slug===view.focus&&row.side===side);return <p key={side}><b>{(side==='YES'?identity?.yesName:identity?.noName)??side}</b>: {latest?.reason??'Not checked yet.'}</p>;})}</details>}
  </div>;
}
