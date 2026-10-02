import type {TennisMarket,TennisRuntime,TennisSession} from './types';

/**
 * How old the bot's last check may be before the card says it is behind. A normal background-runner cycle can take
 * 15–20 s (books, game report, and the owner's 30-second research sweep), so a 20 s limit flickered on a healthy bot.
 */
export const CHECK_STALE_MS={service:45_000,browser:30_000} as const;
const cents=(price:number)=>`${+(price*100).toFixed(1)}¢`;

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
  const staleAfter=runtime?.mode==='service'?CHECK_STALE_MS.service:CHECK_STALE_MS.browser;
  const checkStale=active&&(checkAge===null||checkAge>staleAfter);
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
    checkStale?'Bot is behind':quoting?'Buy offers posted':forming?'Setup forming':'Watching';
  // Plain-English summary of the resting orders: which team, what price, and what makes them trade.
  const offers=quoting&&session.maker?(['YES','NO'] as const).flatMap(side=>{const quote=session.maker!.quotes[side];if(!quote)return [];
    const name=identity?(side==='YES'?identity.yesName:identity.noName):side;return [`${name} at ${cents(quote.price)}`];}):[];
  const reason=runtime?.mode==='migrating'?'Entries are paused while the saved account moves to the background runner.':
    pausedFlat?(budgetReached?`Daily storage budget reached (${usage!.estimatedRowsWritten.toLocaleString()} / ${usage!.entryPauseAt.toLocaleString()} estimated rows). Entries remain paused; the daily allowance renews at 00:00 UTC. Resetting the paper balance will not clear it.`:
      /paused/i.test(session.lastReason)?`${session.lastReason} Press Start when ready.`:`${session.lastReason} Entries are paused; press Start when ready.`):
    session.status==='idle'?(focus?'The paper bot has not started. Press Start to check the saved bot focus.':'Choose a bot focus, then press Start to begin paper checks.'):
    session.status==='stopped'?'This paper run is stopped. Its chart can still update; create a new run when ready.':
    checkStale?`The bot's last check was ${checkAge===null?'not recorded':`${Math.round(checkAge/1000)} seconds ago`}. It normally checks every few seconds; if this lasts more than a minute, reload the page.`:
    runtime?.failureReason||(offers.length?`Offering to buy ${offers.join(' and ')}. A trade happens only when someone sells at that price, so most checks change nothing.`:session.lastReason);
  return {state,reason,quoteAge,gameAge,checkAge,checkStale,focus,side,
    focusName:identity?`${identity.yesName} vs. ${identity.noName}`:focus?`${focus} (not in the current game list)`:'No game selected',
    identityKnown:!!identity,football:identity?.league==='CFB'||identity?.league==='NFL'||!!report,
    checkLabel:runtime?.mode==='service'?'Runner update':'Bot update'};
}
