import type {TennisSession} from './types';

/** Select evidence for the displayed game/outcome; never borrow another game's fresh analysis. */
export function decisionEvidence(session:TennisSession,slug:string|null,side?:'YES'|'NO'){
  if(!slug)return null;
  const held=session.positions.find(position=>position.status==='open'&&position.slug===slug&&(!side||position.side===side));
  if(held?.entryAnalysis||held?.exitPlan){
    const exit=session.decisions.findLast(decision=>decision.slug===slug&&decision.side===held.side&&decision.time>=held.openedAt&&decision.exitAnalysis);
    return {label:'Held entry scenario',side:held.side,analysis:held.entryAnalysis,time:held.openedAt,
      exitAnalysis:exit?.exitAnalysis,exitTime:exit?.time,plan:held.exitPlan};
  }
  const pending=session.pending;
  if(pending?.action==='BUY'&&pending.slug===slug&&(!side||pending.side===side)&&pending.analysis)
    return {label:'Pending entry analysis',side:pending.side,analysis:pending.analysis,time:pending.createdAt};
  const decision=session.decisions.findLast(row=>row.slug===slug&&(!side||row.side===side)&&row.analysis);
  return decision?{label:'Latest entry check',side:decision.side,analysis:decision.analysis,time:decision.time}:null;
}
