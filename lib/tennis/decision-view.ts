import type {TennisMarket,TennisRuntime,TennisSession} from './types';
import {canAcknowledgeLoss,lossAllowance,lossLimitReached} from './loss-limit.ts';

/**
 * How old the bot's last check may be before the card says it is behind. A normal background-runner cycle can take
 * 15–20 s (books, game report, and the owner's 30-second research sweep), so a 20 s limit flickered on a healthy bot.
 */
export const CHECK_STALE_MS={service:45_000,browser:30_000} as const;
const cents=(price:number)=>`${+(price*100).toFixed(1)}¢`;

/**
 * Times come from the server and runner clocks, `now` from this device. A device a little behind the server sees a
 * just-made check slightly in the future; that is "just now", not unknown (treating it as unknown made the card flip
 * to stale and back every few seconds). Only a time far in the future is rejected.
 */
export const CLOCK_SKEW_MS=15_000;
const evidenceAge=(time:number|undefined|null,now:number)=>typeof time!=='number'||!Number.isFinite(time)||time<0?null:
  time<=now?now-time:time-now<=CLOCK_SKEW_MS?0:null;

/** Describe saved bot authority only. Display-only feed polling cannot advance these clocks. */
export function decisionView(session:TennisSession,market:TennisMarket|undefined,runtime:TennisRuntime|null,now:number){
  // While running, the card follows the bot's chosen game; shares still held on a previous game are listed under
  // Open orders & shares. Otherwise (paused, stopping) it stays on what is held or pending.
  const anyHeld=session.positions.find(position=>position.status==='open');
  const switched=session.status==='running'&&!!session.config.focusSlug&&!!anyHeld&&anyHeld.slug!==session.config.focusSlug&&!session.pending;
  const focus=switched?session.config.focusSlug:anyHeld?.slug??session.pending?.slug??session.config.focusSlug;
  const held=session.positions.find(position=>position.status==='open'&&position.slug===focus);
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
  const lossStopped=session.status==='stopped'&&lossLimitReached(session,session.cash);
  const usage=runtime?.mode==='service'?runtime.usage:undefined;
  const budgetReached=!!usage&&usage.day===new Date(now).toISOString().slice(0,10)&&usage.estimatedRowsWritten>=usage.entryPauseAt;
  const quoting=!!session.maker&&(!!session.maker.quotes.YES||!!session.maker.quotes.NO);
  const holdLabel=held?.exitPolicy==='hold-to-settlement'?'Holding to final':held?.exitPolicy==='maker'?'Market making':held?.exitPolicy==='drive'?'Riding the drive':'Holding';
  const state=runtime?.mode==='migrating'?'Setup paused':session.pending?.action==='SELL'||session.exitRequested||session.status==='stopping'?'Exiting':
    held?(session.status==='paused'?`${holdLabel} · entries paused`:holdLabel):session.pending?.action==='BUY'?'Buying':
    pausedFlat?'Paused':lossStopped?'Loss limit hit':session.status==='stopped'?'Stopped':session.status==='idle'?'Ready':!focus?'Choose a game':
    checkStale?'Bot is behind':quoting?'Buy offers posted':forming?'Setup forming':'Watching';
  // Plain-English summary of the resting orders: which team, what price, and what makes them trade.
  const offers=quoting&&session.maker?(['YES','NO'] as const).flatMap(side=>{const quote=session.maker!.quotes[side];if(!quote)return [];
    const name=identity?(side==='YES'?identity.yesName:identity.noName):side;return [`${name} at ${cents(quote.price)}`];}):[];
  const reason=runtime?.mode==='migrating'?'Entries are paused while the saved account moves to the background runner.':
    pausedFlat?(budgetReached?`Daily storage budget reached (${usage!.estimatedRowsWritten.toLocaleString()} / ${usage!.entryPauseAt.toLocaleString()} estimated rows). Entries remain paused; the daily allowance renews at 00:00 UTC. Resetting the paper balance will not clear it.`:
      /paused/i.test(session.lastReason)?`${session.lastReason} Press Start when ready.`:`${session.lastReason} Entries are paused; press Start when ready.`):
    session.status==='idle'?(focus?'The paper bot has not started. Press Start to check the saved bot focus.':'Choose a bot focus, then press Start to begin paper checks.'):
    lossStopped?(canAcknowledgeLoss(session)?`The loss limit was reached. Acknowledge the loss to resume this run with another $${lossAllowance(session).toFixed(2)} loss allowance. Your balance and history stay intact.`:
      session.cash<=0?'The loss limit was reached and no cash remains. Start a new run when ready.':'The loss limit was reached. Existing exits must finish before the loss can be acknowledged.'):
    session.status==='stopped'?'This paper run is stopped. Its chart can still update; create a new run when ready.':
    checkStale?`The bot's last check was ${checkAge===null?'not recorded':`${Math.round(checkAge/1000)} seconds ago`}. It normally checks every few seconds; if this lasts more than a minute, reload the page.`:
    runtime?.failureReason||(offers.length?`Offering to buy ${offers.join(' or ')}. It fills only if someone sells at that price.`:session.lastReason);
  return {state,reason,quoteAge,gameAge,checkAge,checkStale,focus,side,
    focusName:identity?`${identity.yesName} vs. ${identity.noName}`:focus?`${focus} (not in the current game list)`:'No game selected',
    identityKnown:!!identity,football:identity?.league==='CFB'||identity?.league==='NFL'||!!report,
    checkLabel:runtime?.mode==='service'?'Runner update':'Bot update'};
}

/**
 * One line per team for "Both sides". The bot checks both teams on every pass, but it files game-wide notes (offers
 * on both teams, rule saves) under the first team, so "latest note for this team" left the second team looking
 * unchecked. Each line comes from that team's own state: what is held, the resting offer, the engine's verdict.
 */
export function sideLines(session:TennisSession,focus:string|null|undefined,names:{yesName?:string;noName?:string}|undefined){
  return (['YES','NO'] as const).map(side=>{
    const name=(side==='YES'?names?.yesName:names?.noName)??side;
    if(!focus)return {side,name,text:'Not checked yet.'};
    const held=session.positions.find(position=>position.status==='open'&&position.slug===focus&&position.side===side);
    const offer=session.maker?.slug===focus?session.maker.quotes[side]:undefined;
    const plan=session.enginePlan?.slug===focus?session.enginePlan:undefined;
    const considered=plan?.considered.find(trade=>trade.side===side);
    const parts:string[]=[];
    if(held)parts.push(`Holding ${+held.quantity.toFixed(2)} at ${cents(held.entryPrice)} average.`);
    if(offer)parts.push(`Offer to buy ${+offer.quantity.toFixed(2)} at ${cents(offer.price)} is posted.`);
    else if(considered)parts.push(considered.result==='ACTION'?`Planned: ${considered.style==='maker'?'post an offer':'buy'} at ${cents(considered.price)}.`:`Not trading: ${considered.reason}`);
    if(!parts.length){const latest=session.decisions.findLast(row=>row.slug===focus&&row.side===side);parts.push(latest?.reason??plan?.why?.detail??'Checked with the game; nothing to do on this side.');}
    return {side,name,text:parts.join(' ')};
  });
}
