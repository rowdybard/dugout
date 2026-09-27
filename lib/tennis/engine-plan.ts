import {createEngine,type Engine,type Plan} from '../decision/engine.ts';
import {packFor} from '../decision/registry.ts';
import type {DecisionContext,PricePoint} from '../decision/context.ts';
import type {Phase,Style} from '../decision/evidence.ts';
import type {RiskState} from '../decision/risk.ts';
import type {TennisInput,TennisSession} from './types';

/**
 * Adapter between the paper bot's session/inputs and the decision engine (lib/decision).
 * Pure: the same session, input and time always give the same context, engine and plan.
 */

/** What the bot records on an engine-planned intent and position. */
export type PlanEntry={
  strategy:string;strategyVersion:string;style:Style;phase:Phase;
  exit:'hold-to-settlement';
  code:string;evidence:string|null;pack:string;stake:number;reason:string;
};
/** The latest plan, compact enough to keep in session state for the dashboard. */
export type CompactPlan={
  time:number;slug:string;phase:Phase|null;pack:string;trust:string;summary:string;
  considered:{strategy:string;side:'YES'|'NO';style:Style;price:number;stake:number;result:string;reason:string}[];
};

const round=(x:number)=>Math.round(x*1e6)/1e6;
const MARKET_STATUS_MAX_AGE_MS=45_000;

/** The session's evidence engine, sized to the bot's own limits. Null pack means the bundled one. */
export function sessionEngine(session:TennisSession):{engine:Engine}|{error:string} {
  const entry=packFor(session.config.evidencePack);
  if(!entry)return {error:`Evidence pack ${session.config.evidencePack} is not loaded on this host. New entries are blocked until it is.`};
  const cap=Math.min(100,session.config.startingCash*0.25);
  const lossLimit=session.config.startingCash*session.config.maxSessionLossFraction;
  return {engine:createEngine({pack:entry.pack,trust:entry.trust,
    sizing:{bankroll:session.config.startingCash,kellyFraction:0.25,maxStake:Math.min(session.config.entryBudget,cap),maxBankrollFraction:0.25,paperStake:session.config.entryBudget},
    risk:{maxDailyLoss:lossLimit,maxSessionLoss:lossLimit,maxOpenExposure:cap,maxTradesPerDay:20,maxDataAgeMs:session.config.maxBookAgeMs}})};
}

/**
 * pregame: open, not live, before the scheduled start. live: reported live. Anything else (ended, suspended,
 * started but not yet reported live, stale status) is null and the engine will not trade it.
 */
export function marketPhase(input:TennisInput,now:number):Phase|null {
  const market=input.market;
  if(market.ended||!market.active||!Number.isFinite(market.observedAt)||market.observedAt>now||now-market.observedAt>MARKET_STATUS_MAX_AGE_MS)return null;
  if(market.live)return 'live';
  const start=Date.parse(market.startTime);
  return Number.isFinite(start)&&now<start?'pregame':null;
}

function periodNumber(period:string|null):number|null {
  const match=/^(?:Q|Set\s*)(\d)$/i.exec(period?.trim()??'');
  return match?Number(match[1]):null;
}

export function decisionContext(session:TennisSession,input:TennisInput,now:number,phase:Phase|null):DecisionContext {
  const market=input.market;
  const bid=input.book.bids.reduce<TennisInput['book']['bids'][number]|null>((best,level)=>level.quantity>0&&(!best||level.price>best.price)?level:best,null);
  const ask=input.book.asks.reduce<TennisInput['book']['asks'][number]|null>((best,level)=>level.quantity>0&&(!best||level.price<best.price)?level:best,null);
  const start=Date.parse(market.startTime);
  const history:PricePoint[]=(session.histories[`${market.slug}:YES`]??[]).map(point=>({time:point.time,yesBid:point.bid??null,yesAsk:point.ask??null}));
  return {now,...(phase?{phase}:{}),
    market:{slug:market.slug,sport:market.league,title:market.title,startTime:Number.isFinite(start)?start:null,
      feeCoefficient:market.execution?.feeCoefficient??null,open:input.book.state==='MARKET_STATE_OPEN',observedAt:input.receivedAt,
      yes:{name:market.yesName,ask:ask?.price??null,bid:bid?.price??null,askSize:ask?.quantity??null,bidSize:bid?.quantity??null},
      no:{name:market.noName,ask:bid?round(1-bid.price):null,bid:ask?round(1-ask.price):null,askSize:bid?.quantity??null,bidSize:ask?.quantity??null}},
    game:{status:market.ended?'final':phase==='live'?'live':'scheduled',period:periodNumber(market.period),observedAt:market.contextUpdatedAt},
    history};
}

/** Risk state from the paper account, using the same realised-loss measure as the bot's own stop. */
export function sessionRisk(session:TennisSession,now:number):RiskState {
  const day=new Date(now).toISOString().slice(0,10),today=session.ledger.filter(entry=>new Date(entry.time).toISOString().slice(0,10)===day);
  const open=session.positions.filter(position=>position.status==='open');
  return {dayPnl:today.reduce((sum,entry)=>sum+entry.realizedPnl,0),
    sessionPnl:session.positions.reduce((sum,position)=>sum+position.realizedPnl,0),
    openExposure:open.reduce((sum,position)=>sum+position.costBasis,0),
    tradesToday:today.filter(entry=>entry.action==='BUY').length,
    halted:session.status==='running'?null:`bot is ${session.status}`};
}

export function compactPlan(plan:Plan):CompactPlan {
  return {time:plan.time,slug:plan.slug,phase:plan.phase,pack:plan.pack,trust:plan.trust,summary:plan.summary,
    considered:plan.considered.slice(0,8).map(trade=>({strategy:trade.proposal.strategy,side:trade.proposal.side==='yes'?'YES' as const:'NO' as const,
      style:trade.proposal.style,price:trade.proposal.price,stake:trade.stake,result:trade.blocked??'ACTION',reason:trade.reason.slice(0,300)}))};
}
