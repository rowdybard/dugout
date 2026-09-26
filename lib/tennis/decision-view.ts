import type {TennisMarket,TennisRuntime,TennisSession} from './types';

export function decisionView(session:TennisSession,market:TennisMarket|undefined,runtime:TennisRuntime|null,now:number){
  const held=session.positions.find(position=>position.status==='open');
  const focus=held?.slug??session.config.focusSlug;
  const signal=focus?['YES','NO'].flatMap(side=>[session.signals[`${focus}:${side}`],session.autoSignals?.[`${focus}:${side}`]]):[];
  const state=session.pending?.action==='SELL'||session.exitRequested?'Exiting':session.pending?.action==='BUY'?'Buying':held?'Holding':signal.some(value=>value&&['DIP','RECOVERING','RISING'].includes(value.phase))?'Setup forming':'Watching';
  const quote=focus?session.quotes?.[focus]:undefined;
  const report=focus?session.footballReports?.[focus]?.assessment:undefined;
  const quoteTime=quote?.time??market?.quoteObservedAt;
  const pausedFlat=session.status==='paused'&&!held&&!session.pending;
  const pausedReason=runtime?.mode==='service'?'Entries paused. Press Start when you want the background bot to watch this game.':runtime?.mode==='migrating'?'Entries paused while your saved account moves to the background runner.':null;
  return {state:pausedFlat?'Watching':state,quoteAge:quoteTime?Math.max(0,now-quoteTime):null,
    gameAge:report?.reportTime?Math.max(0,now-report.reportTime):market?.contextUpdatedAt?Math.max(0,now-market.contextUpdatedAt):null,
    football:market?.league==='CFB'||market?.league==='NFL',reason:runtime?.failureReason||(pausedFlat&&pausedReason)||session.lastReason};
}
