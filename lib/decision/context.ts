import type {Phase,Sport} from './evidence.ts';
import type {GameEvent} from './events.ts';

/**
 * What the engine knows about one market at one moment. Everything is optional except the market,
 * so any source (bot, runner, script, replay, future live feeds) can supply what it has.
 */

export type SideKey='yes'|'no';
export type FeatureValue=number|string|boolean;

export type Quote={ask:number|null;bid:number|null;askSize?:number|null;bidSize?:number|null;
  /** This side's ask ladder, best first, when the book is known: used for depth and slippage. */
  asks?:readonly {price:number;quantity:number}[];bids?:readonly {price:number;quantity:number}[]};
export type MarketSnapshot={
  slug:string;sport:Sport;title?:string;
  /** Scheduled start, epoch ms. */
  startTime:number|null;
  /** Taker fee coefficient from market metadata; research fallback 0.0695. */
  feeCoefficient?:number|null;
  open?:boolean;observedAt?:number|null;
  yes:Quote&{name?:string};no:Quote&{name?:string};
  /** YES midpoint at the last pregame book Dugout saw, when it saw one. */
  pregameYesMid?:number|null;
};
export type GameState={
  status:'scheduled'|'live'|'final';
  period?:number|null;secondsRemaining?:number|null;
  yesScore?:number|null;noScore?:number|null;
  observedAt?:number|null;
  /** Sport-specific facts (down, outs, possession, pitcher...), readable as features `game.<key>`. */
  extra?:Record<string,FeatureValue|null>;
};
export type PricePoint={time:number;yesBid:number|null;yesAsk:number|null};

export type DecisionContext={
  now:number;market:MarketSnapshot;
  /** Explicit phase; otherwise derived from the game state and the scheduled start. */
  phase?:Phase;
  game?:GameState|null;
  /** Recent YES quotes, oldest first. */
  history?:readonly PricePoint[];
  /** Research plug: externally computed facts (news, injuries, lineups, model outputs), readable as `signal.<name>`. */
  signals?:Record<string,FeatureValue|null>;
  /** Game events so far (lib/decision/events.ts), oldest first. */
  events?:readonly GameEvent[];
};

export function phaseOf(ctx:DecisionContext):Phase|null {
  if(ctx.phase)return ctx.phase;
  if(ctx.game?.status==='final')return null;
  if(ctx.game?.status==='live')return 'live';
  if(ctx.market.startTime===null)return null;
  return ctx.now<ctx.market.startTime?'pregame':'live';
}

export const quoteOf=(ctx:DecisionContext,side:SideKey):Quote=>ctx.market[side];
export const otherSide=(side:SideKey):SideKey=>side==='yes'?'no':'yes';

/** Polymarket US books list YES only; NO prices are complements. */
export function sidesFromYesBook(yes:{ask:number|null;bid:number|null}):{yes:Quote;no:Quote} {
  const flip=(x:number|null)=>x===null?null:Math.round((1-x)*1e6)/1e6;
  return {yes:{ask:yes.ask,bid:yes.bid},no:{ask:flip(yes.bid),bid:flip(yes.ask)}};
}
