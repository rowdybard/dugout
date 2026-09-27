import type {TennisMarket,TennisRuntime,TennisSession} from '@/lib/tennis/types';
import {decisionView} from '@/lib/tennis/decision-view';
import {decisionEvidence} from '@/lib/tennis/decision-evidence';
import {DecisionMetrics} from './decision-metrics';

const age=(value:number|null)=>value===null?'waiting for data':value<1000?'under 1s':value<60000?`${Math.floor(value/1000)}s old`:`${Math.floor(value/60000)}m old`;
export function DecisionCard({session,market,runtime,now}:{session:TennisSession;market?:TennisMarket;runtime:TennisRuntime|null;now:number}){
  const view=decisionView(session,market,runtime,now);
  const held=session.positions.find(position=>position.status==='open');
  const evidence=decisionEvidence(session,held?.slug??session.config.focusSlug);
  const name=evidence?(evidence.side==='YES'?market?.yesName:market?.noName)??held?.name??evidence.side:'';
  return <div className="tennis-decision-card"><strong>{view.state}</strong><p role="status">{view.reason}</p><div><span>Last bot quote: {age(view.quoteAge)}</span>{view.football&&<span>Game report: {age(view.gameAge)}</span>}</div>{evidence&&<DecisionMetrics {...evidence} name={name} now={now}/>}</div>;
}
