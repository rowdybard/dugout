import type {TennisMarket,TennisRuntime,TennisSession} from './types';

const evidenceAge=(time:number|undefined|null,now:number)=>typeof time==='number'&&Number.isFinite(time)&&time<=now&&time>=0?now-time:null;

/** Describe saved bot authority only. Display-only feed polling cannot advance these clocks. */
export function decisionView(session:TennisSession,market:TennisMarket|undefined,runtime:TennisRuntime|null,now:number){
  const held=session.positions.find(position=>position.status==='open');
  const focus=held?.slug??session.pending?.slug??session.config.focusSlug;
  const savedMarket=focus?session.positions.findLast(position=>position.slug===focus)?.market:undefined;
  const identity=market?.slug===focus?market:held?.slug===focus?held.market:
    session.pending?.slug===focus?session.pending.market:savedMarket;
  const quote=focus?session.quotes?.[focus]:undefined;
  const report=focus?session.footballReports?.[focus]?.assessment:undefined;
  const quoteAge=evidenceAge(quote?.time,now);
  const gameAge=evidenceAge(report?.reportTime,now);
  const checkAge=evidenceAge(runtime?.mode==='service'?runtime.lastSuccessfulCheck:session.lastTickAt,now);
  const active=session.status==='running'||session.status==='stopping'||!!held||!!session.pending;
  const checkStale=active&&(checkAge===null||checkAge>20000);
  const reasonDecision=focus?session.decisions.findLast(row=>row.slug===focus&&row.reason===session.lastReason):undefined;
  const side=held?.side??session.pending?.side??reasonDecision?.side;
  const signal=focus?(['YES','NO'] as const).map(outcome=>session.signals[`${focus}:${outcome}`]):[];
  const forming=quoteAge!==null&&quoteAge<=session.config.maxBookAgeMs&&signal.some(value=>value&&
    value.lastObservedAt===quote?.time&&['DIP','RECOVERING','RISING'].includes(value.phase));
  const pausedFlat=session.status==='paused'&&!held&&!session.pending;
  const usage=runtime?.mode==='service'?runtime.usage:undefined;
  const budgetReached=!!usage&&usage.day===new Date(now).toISOString().slice(0,10)&&usage.estimatedRowsWritten>=usage.entryPauseAt;
  const quoting=!!session.maker&&(!!session.maker.quotes.YES||!!session.maker.quotes.NO);
  const holdLabel=held?.exitPolicy==='hold-to-settlement'?'Holding to final':held?.exitPolicy==='maker'?'Market making':held?.exitPolicy==='drive'?'Riding the drive':'Holding';
  const state=runtime?.mode==='migrating'?'Setup paused':session.pending?.action==='SELL'||session.exitRequested||session.status==='stopping'?'Exiting':
    held?(session.status==='paused'?`${holdLabel} · entries paused`:holdLabel):session.pending?.action==='BUY'?'Buying':
    pausedFlat?'Paused':session.status==='stopped'?'Stopped':session.status==='idle'?'Ready':!focus?'Choose a game':
    checkStale?'Waiting for a check':quoting?'Market making':forming?'Setup forming':'Watching';
  const reason=runtime?.mode==='migrating'?'Entries are paused while the saved account moves to the background runner.':
    pausedFlat?(budgetReached?`Daily storage budget reached (${usage!.estimatedRowsWritten.toLocaleString()} / ${usage!.entryPauseAt.toLocaleString()} estimated rows). Entries remain paused; the daily allowance renews at 00:00 UTC. Resetting the paper balance will not clear it.`:
      /paused/i.test(session.lastReason)?`${session.lastReason} Press Start when ready.`:`${session.lastReason} Entries are paused; press Start when ready.`):
    session.status==='idle'?(focus?'The paper bot has not started. Press Start to check the saved bot focus.':'Choose a bot focus, then press Start to begin paper checks.'):
    session.status==='stopped'?'This paper run is stopped. Its chart can still update; create a new run when ready.':
    checkStale?'The saved bot check is more than 20 seconds old or unavailable. Live chart updates do not confirm that the bot is checking.':
    runtime?.failureReason||session.lastReason;
  return {state,reason,quoteAge,gameAge,checkAge,checkStale,focus,side,
    focusName:identity?`${identity.yesName} vs. ${identity.noName}`:focus?`${focus} (not in the current game list)`:'No game selected',
    identityKnown:!!identity,football:identity?.league==='CFB'||identity?.league==='NFL'||!!report,
    checkLabel:runtime?.mode==='service'?'Runner update':'Bot update'};
}
