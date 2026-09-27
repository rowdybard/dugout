import type {TennisMarket,TennisRuntime,TennisSession} from '@/lib/tennis/types';
import {decisionView} from '@/lib/tennis/decision-view';
import {decisionEvidence} from '@/lib/tennis/decision-evidence';
import {DecisionMetrics} from './decision-metrics';

const age=(value:number|null)=>value===null?'waiting for data':value<1000?'under 1s':value<60000?`${Math.floor(value/1000)}s old`:`${Math.floor(value/60000)}m old`;
export function DecisionCard({session,market,runtime,now}:{session:TennisSession;market?:TennisMarket;runtime:TennisRuntime|null;now:number}){
  const view=decisionView(session,market,runtime,now);
  const held=session.positions.find(position=>position.status==='open');
  const evidence=decisionEvidence(session,view.focus,view.side);
  const identity=market?.slug===view.focus?market:held?.slug===view.focus?held.market:
    session.pending?.slug===view.focus?session.pending.market:session.positions.findLast(position=>position.slug===view.focus)?.market;
  const name=evidence?(evidence.side==='YES'?identity?.yesName:identity?.noName)??held?.name??evidence.side:'';
  return <div className="tennis-decision-card"><strong>{view.state}</strong><p role="status">{view.reason}</p><div><span>Bot game: {view.focusName}</span><span>Both teams evaluated · one open position</span><span title="Saved check or control-update time. A completed pass can reject its quote; this is separate from accepted book evidence.">{view.checkLabel}: {age(view.checkAge)}</span><span>Accepted bot quote: {age(view.quoteAge)}</span>{view.football&&<span>Bot game report: {age(view.gameAge)}</span>}</div>{evidence&&<DecisionMetrics {...evidence} name={name} now={now}/>}{view.focus&&<details><summary>Compare both teams</summary>{(['YES','NO'] as const).map(side=>{const latest=session.decisions.findLast(row=>row.slug===view.focus&&row.side===side);return <p key={side}><b>{(side==='YES'?identity?.yesName:identity?.noName)??side}</b>: {latest?.reason??'Waiting for the first check.'} {latest&&<small>({age(Math.max(0,now-latest.time))})</small>}</p>;})}</details>}</div>;
}
