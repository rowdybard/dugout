import type {TennisMarket,TennisPosition,TennisSession} from './types';
import {BOLD_STOP,BOLD_TAKE_PROFIT,PAIR_WINDOW_MS} from './maker.ts';
import {tradeMode} from './modes.ts';
import {purchaseAverageWithFees} from './position-average.ts';

/**
 * Everything the bot has working right now, in one list: resting buy offers (main game and Chaos games), a queued
 * order, and the shares it holds. Names come from the live game list when available, else from the saved market.
 */
export type OpenOrder={key:string;slug:string;game:string;team:string;side:'YES'|'NO';kind:'offer'|'queued-buy'|'queued-add'|'queued-sell';price:number;quantity:number|null;reserved:number|null};
export type Holding={key:string;slug:string;game:string;team:string;side:'YES'|'NO';quantity:number;averagePrice:number;averageWithFees:number|null;cost:number;value:number|null;result:number|null;
  policy:'offer fill'|'hold to final'|'drive'|'managed';partial:boolean;
  /** How current the value is (priceOf), and a plain note when it isn't current. */
  price:PriceState;priceNote:string|null;
  /** Offer-fill shares with no matching fill on the other team: sold at the best bid at this time if still unpaired. */
  sellBy:number|null;paired:boolean;
  /** Bold keeps unpaired shares: it still tries to pair, may buy once more on a dip, else holds to the final. */
  boldHold:boolean;
  /** Bold after a dip buy: the bid at which the unpaired shares are sold (loss limit). */
  stopAt:number|null;
  /** Bold: the bid at which the unpaired shares are sold for a profit. */
  takeAt:number|null};

const exact=(x:number)=>Math.round(x*1e6)/1e6;

/**
 * One valuation for the headline balance, the holdings list and "Sell everything": what held shares would sell for at
 * the best bids (after fees), from the bot's latest price check.
 *   current: priced within PRICE_FRESH_MS, every share.   old: priced, but longer ago.
 *   partial: the book could only take some of the shares; the rest have no value yet.   missing: no price at all.
 */
export type PriceState='current'|'old'|'partial'|'missing';
export const PRICE_FRESH_MS=15_000;
export function priceOf(p:TennisPosition,now:number):{state:PriceState;value:number|null;ageMs:number|null;pricedQuantity:number}{
  if(p.netLiquidationValue===null||!p.markedAt)return {state:'missing',value:null,ageMs:null,pricedQuantity:0};
  const ageMs=Math.max(0,now-p.markedAt),pricedQuantity=Math.min(p.quantity,p.liquidationQuantity);
  const state:PriceState=pricedQuantity+1e-7<p.quantity?'partial':ageMs>PRICE_FRESH_MS?'old':'current';
  return {state,value:p.netLiquidationValue,ageMs,pricedQuantity};
}
/** A plain label for anything but a current price: "price 40 s old", "no price yet", "only 6 of 10 shares priced". */
export function priceNote(price:ReturnType<typeof priceOf>,quantity:number):string|null{
  if(price.state==='missing')return 'no price yet';
  if(price.state==='partial')return `only ${+price.pricedQuantity.toFixed(2)} of ${+quantity.toFixed(2)} shares priced`;
  if(price.state==='old')return `price ${price.ageMs!<120_000?`${Math.round(price.ageMs!/1000)} s`:`${Math.round(price.ageMs!/60_000)} min`} old`;
  return null;
}
/**
 * The account's value: cash plus every holding's known sale value (old and partial prices included, missing ones at
 * zero). `complete` is true only when every holding has a current price for all its shares.
 */
export function accountValue(session:TennisSession,now:number){
  const open=session.positions.filter(p=>p.status==='open'),prices=open.map(p=>priceOf(p,now));
  const value=exact(session.cash+prices.reduce((sum,price)=>sum+(price.value??0),0));
  const count=(state:PriceState)=>prices.filter(price=>price.state===state).length;
  const notes=[count('old')&&`${count('old')} price${count('old')>1?'s':''} old`,count('partial')&&`${count('partial')} partly priced`,count('missing')&&`${count('missing')} unpriced`].filter(Boolean) as string[];
  return {value,pnl:exact(value-session.config.startingCash),complete:notes.length===0,note:notes.join(' · ')};
}

export function openBook(session:TennisSession,markets:TennisMarket[],now:number):{orders:OpenOrder[];holdings:Holding[];reserved:number;held:number}{
  const marketOf=(slug:string)=>markets.find(m=>m.slug===slug)??session.positions.findLast(p=>p.slug===slug)?.market??(session.pending?.slug===slug?session.pending.market:undefined);
  const game=(slug:string)=>{const m=marketOf(slug);return m?`${m.yesName} vs. ${m.noName}`:slug;};
  const team=(slug:string,side:'YES'|'NO')=>{const m=marketOf(slug);return m?(side==='YES'?m.yesName:m.noName):side;};
  const orders:OpenOrder[]=[];
  const makers=[...(session.maker?[session.maker]:[]),...Object.values(session.chaos??{})];
  for(const maker of makers)for(const side of ['YES','NO'] as const){
    const quote=maker.quotes[side];if(!quote)continue;
    orders.push({key:`offer:${maker.slug}:${side}`,slug:maker.slug,game:game(maker.slug),team:team(maker.slug,side),side,kind:'offer',price:quote.price,quantity:quote.quantity,reserved:exact(quote.price*quote.quantity)});
  }
  const pending=session.pending;
  if(pending){
    const adding=pending.action==='BUY'&&pending.tennisAdd===true&&!!pending.positionId&&session.positions.some(p=>p.status==='open'&&p.id===pending.positionId&&p.slug===pending.slug&&p.side===pending.side);
    orders.push({key:`queued:${pending.id}`,slug:pending.slug,game:game(pending.slug),team:team(pending.slug,pending.side),side:pending.side,
      kind:pending.action==='BUY'?adding?'queued-add':'queued-buy':'queued-sell',price:pending.limitPrice,quantity:null,reserved:pending.action==='BUY'?pending.budget??null:null});
  }
  const makerQty=(slug:string,side:'YES'|'NO')=>session.positions.filter(p=>p.status==='open'&&p.exitPolicy==='maker'&&p.slug===slug&&p.side===side).reduce((sum,p)=>sum+p.quantity,0);
  const holdings:Holding[]=session.positions.filter(p=>p.status==='open').map(p=>{
    const mine=p.exitPolicy==='maker'?makerQty(p.slug,p.side):0,theirs=p.exitPolicy==='maker'?makerQty(p.slug,p.side==='YES'?'NO':'YES'):0;
    const paired=p.exitPolicy==='maker'&&theirs>0&&mine<=theirs+1e-9,unpairedSide=p.exitPolicy==='maker'&&mine>theirs+1e-9;
    const price=priceOf(p,now),marked=price.value!==null;
    // A partly priced holding is compared with the cost of the shares that are priced.
    const pricedCost=p.quantity>0?p.costBasis*price.pricedQuantity/p.quantity:0;
    return {key:p.id,slug:p.slug,game:game(p.slug),team:team(p.slug,p.side)||p.name,side:p.side,quantity:p.quantity,averagePrice:p.entryPrice,averageWithFees:purchaseAverageWithFees(p),cost:p.costBasis,
      value:price.value,result:marked?exact(price.value!-pricedCost):null,price:price.state,priceNote:priceNote(price,p.quantity),
      policy:p.exitPolicy==='maker'?'offer fill':p.exitPolicy==='hold-to-settlement'?'hold to final':p.exitPolicy==='drive'?'drive':'managed',
      partial:price.state==='partial',sellBy:unpairedSide&&tradeMode(session)==='steady'?p.openedAt+PAIR_WINDOW_MS:null,paired,boldHold:unpairedSide&&tradeMode(session)==='bold',
      stopAt:unpairedSide&&tradeMode(session)==='bold'&&(p.dipBuys??0)>=1?Math.round((p.entryPrice-BOLD_STOP)*1e6)/1e6:null,
      takeAt:unpairedSide&&tradeMode(session)==='bold'?Math.round((p.entryPrice+BOLD_TAKE_PROFIT)*1e6)/1e6:null};
  });
  return {orders,holdings,reserved:exact(orders.reduce((sum,o)=>sum+(o.reserved??0),0)),held:exact(holdings.reduce((sum,h)=>sum+h.cost,0))};
}
