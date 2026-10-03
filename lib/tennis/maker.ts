import type {FootballReportState,TennisMarket} from './types';
import {feeUnits,fromUnits,toUnits} from '../trading/money.ts';

/**
 * Paper market making: pure helpers. The bot rests a buy on each side at that side's best bid (a two-sided quote:
 * buying NO at its bid is offering YES at 1 minus it). Fills use the research's CONSERVATIVE model: a resting buy
 * fills only when a later book shows that side's best ask at or below our price, which means every bid at our
 * level was taken, ours included. Real fills (queue position, touches that do not clear the level) fall between
 * this and the optimistic model, so paper results here understate fills and overstate adverse selection.
 */

/**
 * Polymarket US maker rebate (docs.polymarket.us/fees): 0.0125 · C · p · (1 − p), credited to the resting side at
 * execution and rounded to the cent, half to even, like the taker fee.
 */
export const MAKER_REBATE_COEFFICIENT=0.0125;
/** Wider books are placeholder quotes in the research, not markets to make. */
export const MAX_QUOTE_SPREAD=0.05;
/** Stop adding to one side once its inventory cost reaches this multiple of the quote stake. */
export const INVENTORY_MULTIPLE=2;
/** One-sided fill: how long to wait for the other team's offer to fill before selling the unpaired shares. */
export const PAIR_WINDOW_MS=10*60_000;
/** A completing offer keeps the pair's total cost at most 1 − this (a pair pays $1 at the end). */
export const PAIR_MIN_EDGE=0.005;
/** Bold, one-sided: buy more once when the price is at least this far below what was paid. */
export const DIP_STEP=0.05;
/** Bold, one-sided: total cost in one game's unpaired side is capped at this multiple of the order size. */
export const DIP_CAP_MULTIPLE=2;
/** Bold, after a dip buy: sell the unpaired shares if the best bid falls this far below their average price. */
export const BOLD_STOP=0.10;

export type RestingQuote={price:number;quantity:number;placedAt:number;placedBookTime:number;activeAfter:number};
export type MakerState={
  slug:string;
  /** Resting buys by contract side: YES at the YES bid, NO at the NO bid. */
  quotes:{YES?:RestingQuote;NO?:RestingQuote};
  pulledUntil:number;eventKey:string|null;lastBookTime:number;reason:string;
  fills:number;rebates:number;
};

const exact=(value:number)=>Math.round(value*1_000_000)/1_000_000;

export const makerRebate=(price:number,quantity:number)=>fromUnits(feeUnits(toUnits(quantity),toUnits(price),toUnits(MAKER_REBATE_COEFFICIENT)));

/** Whole increments of contracts affordable for `stake` dollars at `price`; zero below the market minimum. */
export function quoteQuantity(stake:number,price:number,increment:number,minimum:number):number {
  if(!(stake>0)||!(price>0&&price<1)||!(increment>0))return 0;
  const quantity=exact(Math.floor(stake/price/increment+1e-9)*increment);
  return quantity>=minimum-1e-9?quantity:0;
}

/** Conservative fill: the side's best ask reached our resting price on a book received after the quote went live. */
export function restingFilled(quote:RestingQuote,sideAsk:number|undefined,bookReceivedAt:number):boolean {
  return sideAsk!==undefined&&bookReceivedAt>=quote.activeAfter&&sideAsk<=quote.price+1e-9;
}

/**
 * A play/point boundary: quotes are pulled for a while after it, because the reaction studies show informed
 * flow moves the price in the seconds after each event. Pregame has no events.
 */
export function eventKey(market:TennisMarket,report:FootballReportState|undefined):string {
  const r=report?.report;
  return JSON.stringify(r?[r.score,r.period,r.possessionTeamId,r.down,r.yardsToGo,r.fieldPosition.teamId,r.fieldPosition.yard]:[market.score,market.period]);
}

export function sameQuote(a:RestingQuote|undefined,price:number,quantity:number):boolean {
  return !!a&&Math.abs(a.price-price)<1e-9&&Math.abs(a.quantity-quantity)<1e-9;
}
