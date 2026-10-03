import {createEngine,type Engine,type Plan} from '../decision/engine.ts';
import {packFor} from '../decision/registry.ts';
import type {DecisionContext,PricePoint} from '../decision/context.ts';
import type {Phase,Style} from '../decision/evidence.ts';
import type {RiskState} from '../decision/risk.ts';
import {QUARTER_SECONDS,tennisSignalKey} from '../decision/sports/index.ts';
import type {FeatureValue} from '../decision/context.ts';
import type {TennisConfig,TennisInput,TennisMarket,TennisSession,TennisSignal} from './types';
import type {NoTradeCode} from '../decision/why.ts';
import {restingCost} from './maker.ts';
import {accountLimitsOn,spendFraction} from './account-limits.ts';
import {dayRiskPnl,lossAllowance,sessionPnl} from './loss-limit.ts';
import {walletCommitments,walletProjection} from './wallet-risk.ts';

/**
 * Money the account has committed outside `exceptSlug`'s resting offers: held shares at cost, a pending buy's budget,
 * and resting offers on every other game. Checked against SPEND_LIMIT_FRACTION of the balance.
 */
export function committed(session:Pick<TennisSession,'positions'|'pending'|'maker'|'chaos'>,exceptSlug?:string):number {
  const held=session.positions.filter(p=>p.status==='open').reduce((sum,p)=>sum+p.costBasis,0);
  const pending=session.pending?.action==='BUY'?session.pending.budget??0:0;
  const offers=[session.maker,...Object.values(session.chaos??{})].filter(state=>state&&state.slug!==exceptSlug).reduce((sum,state)=>sum+restingCost(state),0);
  return Math.round((held+pending+offers)*1e6)/1e6;
}

/**
 * Adapter between the paper bot's session/inputs and the decision engine (lib/decision).
 * Pure: the same session, input and time always give the same context, engine and plan.
 */

/** What the bot records on an engine-planned intent and position. */
export type PlanEntry={
  strategy:string;strategyVersion:string;style:Style;phase:Phase;
  /** hold-to-settlement: held to the final. drive: sold when the football drive ends, at the stop, or at the time limit. */
  exit:'hold-to-settlement'|'drive'|'scalp'|'tennis-trend';
  drive?:{stopReturn:number;maxHoldMs:number};
  scalp?:{targetReturn:number;stopReturn:number;maxHoldMs:number};
  trend?:import('./trend-exit.ts').TennisTrendRules;
  /** The setup this entry traded (one entry per setup, lib/decision/strategies.ts Proposal.setupKey). */
  setupKey?:string;
  code:string;evidence:string|null;pack:string;stake:number;reason:string;
};
/** The latest plan, compact enough to keep in session state for the dashboard. */
export type CompactPlan={
  time:number;slug:string;phase:Phase|null;pack:string;trust:string;summary:string;
  /** `code` is the evidence verdict (EXPLORE_PAPER marks a paper test of an unmeasured idea). */
  considered:{strategy:string;side:'YES'|'NO';style:Style;price:number;stake:number;result:string;code?:string;reason:string}[];
  /** The primary reason there was no action, and why strategies that did not propose declined. */
  why?:{strategy:string;code:NoTradeCode;detail:string}|null;
  notes?:{strategy:string;code:NoTradeCode;detail:string}[];
};

const round=(x:number)=>Math.round(x*1e6)/1e6;
const MARKET_STATUS_MAX_AGE_MS=45_000;

/** The session's evidence engine, sized to the bot's own limits. Null pack means the bundled one. */
export function sessionEngine(session:TennisSession):{engine:Engine}|{error:string} {
  const entry=packFor(session.config.evidencePack);
  if(!entry)return {error:`Evidence pack ${session.config.evidencePack} is not loaded on this host. New entries are blocked until it is.`};
  const cap=Math.min(100,session.config.startingCash*0.25);
  // A shared wallet (tennis + football bots) has its own 50% cap; a single bot uses SPEND_LIMIT_FRACTION of its balance.
  const exposureCap=walletProjection(session)?walletCommitments(session).cap:session.config.startingCash*spendFraction(session);
  // Paper accounts run without the account loss limits (lib/tennis/account-limits.ts).
  const lossLimit=accountLimitsOn(session)?lossAllowance(session):Number.POSITIVE_INFINITY;
  return {engine:createEngine({pack:entry.pack,trust:entry.trust,
    sizing:{bankroll:session.config.startingCash,kellyFraction:0.25,maxStake:Math.min(session.config.entryBudget,cap),maxBankrollFraction:0.25,paperStake:session.config.entryBudget},
    // Each bet is capped at `cap` (maxStake); everything committed together at the account's spending limit.
    // No daily trade-count cap (removed October 3, 2026 at the owner's request): the loss limits and the spending limit govern risk.
    risk:{maxDailyLoss:lossLimit,maxSessionLoss:lossLimit,maxOpenExposure:exposureCap,maxTradesPerDay:Number.POSITIVE_INFINITY,maxDataAgeMs:session.config.maxBookAgeMs}})};
}

/**
 * pregame: open, not live, before the scheduled start. live: reported live. Anything else (ended, suspended,
 * started but not yet reported live, stale status) is null and the engine will not trade it.
 */
export function marketPhase(input:TennisInput,now:number):Phase|null {
  const market=input.market;
  if(market.ended||!market.active||!Number.isFinite(market.observedAt)||market.observedAt>now)return null;
  const age=now-market.observedAt;
  if(market.live)return age<=MARKET_STATUS_MAX_AGE_MS?'live':null;
  const start=Date.parse(market.startTime);
  return Number.isFinite(start)&&now<start&&age<=pregameStatusMaxAge(start-now)?'pregame':null;
}

/**
 * Before kickoff the game's status changes rarely, so a status up to PREGAME_STATUS_MAX_AGE_MS old still counts,
 * as long as kickoff is further away than that (the game cannot have started since); close to kickoff it needs the
 * usual 45 s. Reports for several games (the Octopus) can lag a little without pulling every pregame offer.
 */
export const PREGAME_STATUS_MAX_AGE_MS=5*60_000;
export const pregameStatusMaxAge=(untilStartMs:number)=>untilStartMs>PREGAME_STATUS_MAX_AGE_MS?PREGAME_STATUS_MAX_AGE_MS:MARKET_STATUS_MAX_AGE_MS;

function periodNumber(period:string|null):number|null {
  const match=/^(?:Q|Set\s*)(\d)$/i.exec(period?.trim()??'');
  return match?Number(match[1]):null;
}

/**
 * How the provider's football clock (eventState.elapsed) runs. Verified Sep 27, 2026 on live NFL games read ~30 s
 * apart: it counts DOWN (Q2 15:00 -> 14:52, Q1 3:22 -> 2:44), despite the field's name. Between quarters it is empty
 * and the period reads "End Q1", which is not a playable quarter, so time left is unknown then.
 */
export const FOOTBALL_CLOCK:'countdown'|'elapsed'|null='countdown';

/** Game seconds left in regulation, or null when the quarter or clock direction is unknown. */
export function footballSecondsRemaining(period:string,clock:string,direction:'countdown'|'elapsed'|null=FOOTBALL_CLOCK):number|null {
  const quarter=/^Q([1-4])$/.exec(period)?.[1],time=/^(\d{1,2}):([0-5]\d)$/.exec(clock);
  if(!quarter||!time||!direction)return null;
  const shown=Number(time[1])*60+Number(time[2]);
  if(shown>QUARTER_SECONDS)return null;
  return (4-Number(quarter))*QUARTER_SECONDS+(direction==='countdown'?shown:QUARTER_SECONDS-shown);
}

/** Scores read "away-home" (verified on NFL and CFB); `yesOrdering` says which one YES is. */
export function sideScores(score:string|null|undefined,ordering:TennisMarket['yesOrdering']):{yesScore:number;noScore:number}|null {
  const match=/^(\d+)\s*-\s*(\d+)$/.exec(score?.trim()??'');
  if(!match||(ordering!=='away'&&ordering!=='home'))return null;
  const away=Number(match[1]),home=Number(match[2]);
  return ordering==='away'?{yesScore:away,noScore:home}:{yesScore:home,noScore:away};
}

/**
 * Football facts for the engine, only from a fresh verified report for this game and team mapping. Anything
 * less (stale, between plays, conflicting) leaves them unknown, and strategies that need them propose nothing.
 */
function footballGame(session:TennisSession,market:TennisMarket,now:number):{period:number|null;secondsRemaining?:number|null;yesScore:number;noScore:number;extra:Record<string,FeatureValue|null>}|null {
  const state=session.footballReports?.[market.slug],report=state?.report,identity=market.footballIdentity;
  // Between plays (scores, kicks, breaks): only the score and period are verified; the ball is dead.
  const transition=state?.transition;
  if(state?.assessment.status==='transition'&&transition&&identity&&transition.eventId===market.eventId&&transition.yesTeamId===identity.yesTeamId&&transition.noTeamId===identity.noTeamId){
    const scores=sideScores(transition.score,market.yesOrdering),since=[...(session.gameTape?.[market.slug]??[])].reverse().find(event=>event.type==='dead-ball');
    return scores?{period:periodNumber(transition.period),...scores,
      extra:{phase:'dead-ball',deadBallSeconds:since&&since.receivedAt<=now?(now-since.receivedAt)/1000:null}}:null;
  }
  if(state?.assessment.status!=='fresh'||!report||!identity||report.eventId!==market.eventId||report.yesTeamId!==identity.yesTeamId||report.noTeamId!==identity.noTeamId)return null;
  const scores=sideScores(report.score,market.yesOrdering);
  if(!scores)return null;
  const possession=report.possessionTeamId===report.yesTeamId?'yes':report.possessionTeamId===report.noTeamId?'no':null;
  if(!possession)return null;
  const own=report.fieldPosition.teamId===report.possessionTeamId;
  return {period:periodNumber(report.period),secondsRemaining:footballSecondsRemaining(report.period,report.clock),...scores,
    extra:{possession,yardsToEndZone:own?100-report.fieldPosition.yard:report.fieldPosition.yard,down:report.down,distance:report.yardsToGo,phase:'play'}};
}

/** Baseball facts older than this are not used (the feed updates every pitch). */
export const BASEBALL_CONTEXT_MAX_AGE_MS=45_000;

/** MLB live state for the engine: only from a fresh, complete report with a verified away/home mapping. */
function baseballGame(market:TennisMarket,now:number):{period:number;yesScore:number;noScore:number;extra:Record<string,FeatureValue|null>}|null {
  const state=market.baseball,updated=market.contextUpdatedAt;
  if(!state||updated==null||now-updated>BASEBALL_CONTEXT_MAX_AGE_MS||updated>now)return null;
  const scores=sideScores(market.score,market.yesOrdering);
  if(!scores)return null;
  // The away team bats in the top half. Between halves nobody is batting.
  const away=market.yesOrdering==='away'?'yes':'no',home=away==='yes'?'no':'yes';
  const batting=state.half==='top'?away:state.half==='bottom'?home:null;
  return {period:state.inning,...scores,extra:{half:state.half,outs:state.outs,balls:state.balls,strikes:state.strikes,
    onFirst:state.onFirst,onSecond:state.onSecond,onThird:state.onThird,battingSide:batting}};
}

/** Each side's ladder, best first. The book lists YES only; NO asks are 1 − YES bids. */
function ladders(input:TennisInput){
  const levels=(side:TennisInput['book']['bids'])=>side.filter(level=>level.quantity>0&&level.price>0&&level.price<1);
  const yesAsks=levels(input.book.asks).sort((a,b)=>a.price-b.price),yesBids=levels(input.book.bids).sort((a,b)=>b.price-a.price);
  const flip=(list:typeof yesAsks)=>list.map(level=>({price:round(1-level.price),quantity:level.quantity}));
  return {yes:{asks:yesAsks.slice(0,10),bids:yesBids.slice(0,10)},no:{asks:flip(yesBids).slice(0,10),bids:flip(yesAsks).slice(0,10)}};
}

export function decisionContext(session:TennisSession,input:TennisInput,now:number,phase:Phase|null):DecisionContext {
  const market=input.market;
  const bid=input.book.bids.reduce<TennisInput['book']['bids'][number]|null>((best,level)=>level.quantity>0&&(!best||level.price>best.price)?level:best,null);
  const ask=input.book.asks.reduce<TennisInput['book']['asks'][number]|null>((best,level)=>level.quantity>0&&(!best||level.price<best.price)?level:best,null);
  const start=Date.parse(market.startTime);
  const history:PricePoint[]=(session.histories[`${market.slug}:YES`]??[]).map(point=>({time:point.time,yesBid:point.bid??null,yesAsk:point.ask??null}));
  const depth=ladders(input);
  return {now,...(phase?{phase}:{}),
    market:{slug:market.slug,sport:market.league,title:market.title,startTime:Number.isFinite(start)?start:null,
      feeCoefficient:market.execution?.feeCoefficient??null,open:input.book.state==='MARKET_STATE_OPEN',observedAt:input.receivedAt,
      yes:{name:market.yesName,ask:ask?.price??null,bid:bid?.price??null,askSize:ask?.quantity??null,bidSize:bid?.quantity??null,...depth.yes},
      no:{name:market.noName,ask:bid?round(1-bid.price):null,bid:ask?round(1-ask.price):null,askSize:bid?.quantity??null,bidSize:ask?.quantity??null,...depth.no},
      pregameYesMid:session.pregame?.[market.slug]?.mid??null,yesOrdering:market.yesOrdering??null},
    game:{status:market.ended?'final':phase==='live'?'live':'scheduled',period:periodNumber(market.period),observedAt:market.footballSources?session.footballReports?.[market.slug]?.assessment.reportTime??null:market.contextUpdatedAt,
      ...(phase==='live'&&(market.league==='NFL'||market.league==='CFB')?footballGame(session,market,now)??{}:{}),
      ...(phase==='live'&&market.league==='MLB'?baseballGame(market,now)??{}:{})},
    history,events:session.gameTape?.[market.slug]??[]};
}

/** Only the existing state machines can supply a confirmed Tennis snapshot; the registered plugs then gate it. */
export function tennisSignalContext(session:TennisSession,input:TennisInput,now:number,side:'YES'|'NO',signal:TennisSignal,config:TennisConfig):DecisionContext {
  const pattern=config.strategy==='momentum'?'momentum':'recovery',key=side==='YES'?'yes':'no';
  const required=pattern==='recovery'?config.recoveryConfirmations:config.momentumConfirmations;
  const values:Record<string,FeatureValue|null>={confirmed:signal.phase===(pattern==='recovery'?'RECOVERING':'RISING')&&signal.confirmations>=required,
    observedAt:signal.lastObservedAt??null,setupAt:signal.dipAt??null,windowMs:config.baselineWindowMs,baseline:signal.baseline??null,baselineBid:signal.baselineBid??null,
    lastBid:signal.lastBid??null,lastPrice:signal.lastPrice??null,trough:signal.trough??null,troughBid:signal.troughBid??null,confirmations:signal.confirmations,requiredConfirmations:required,
    declinePoints:config.declinePoints,recoveryPoints:config.recoveryPoints,momentumPoints:config.momentumPoints,
    targetReturn:config.targetReturn,stopReturn:config.stopReturn,maxHoldMs:config.maxHoldMs,
    strategyVersion:config.tennisTradeStyle==='adaptive-v2'&&config.tennisStrategy==='auto'?'2':'1',
    executionDelayMs:config.executionDelayMs,tickSize:input.market.execution?.priceIncrement??null};
  return {...decisionContext(session,input,now,marketPhase(input,now)),signals:Object.fromEntries(Object.entries(values).map(([field,value])=>[tennisSignalKey(key,pattern,field),value]))};
}

/** Risk state from the paper account, using the same realised-loss measure as the bot's own stop. */
/** `slug`: the game being planned. Its own resting offers are about to be replaced, so they are not counted. */
export function sessionRisk(session:TennisSession,now:number,slug?:string):RiskState {
  const day=new Date(now).toISOString().slice(0,10),today=session.ledger.filter(entry=>new Date(entry.time).toISOString().slice(0,10)===day);
  const open=session.positions.filter(position=>position.status==='open');
  return {dayPnl:dayRiskPnl(session,day),
    sessionPnl:sessionPnl(session),
    openExposure:walletProjection(session)?walletCommitments(session,undefined,true).total:slug===undefined?open.reduce((sum,position)=>sum+position.costBasis,0):committed(session,slug),
    // Resting-quote fills are many small trades by design; the trade-count limit is for taker entries.
    tradesToday:today.filter(entry=>entry.action==='BUY'&&!entry.positionId.includes(':maker:')).length,
    halted:session.status==='running'?null:`bot is ${session.status}`};
}

export function compactPlan(plan:Plan):CompactPlan {
  return {time:plan.time,slug:plan.slug,phase:plan.phase,pack:plan.pack,trust:plan.trust,summary:plan.summary,
    considered:plan.considered.slice(0,10).map(trade=>({strategy:trade.proposal.strategy,side:trade.proposal.side==='yes'?'YES' as const:'NO' as const,
      style:trade.proposal.style,price:trade.proposal.price,stake:trade.stake,result:trade.blocked??'ACTION',code:trade.verdict.code,reason:trade.reason.slice(0,300)})),
    why:plan.why?{...plan.why,detail:plan.why.detail.slice(0,300)}:null,
    notes:plan.notes.slice(0,8).map(note=>({...note,detail:note.detail.slice(0,200)}))};
}
