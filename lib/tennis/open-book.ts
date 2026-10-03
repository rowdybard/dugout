import type {TennisMarket,TennisSession} from './types';
import {PAIR_WINDOW_MS} from './maker.ts';
import {modeOf} from './modes.ts';

/**
 * Everything the bot has working right now, in one list: resting buy offers (main game and Chaos games), a queued
 * order, and the shares it holds. Names come from the live game list when available, else from the saved market.
 */
export type OpenOrder={key:string;slug:string;game:string;team:string;side:'YES'|'NO';kind:'offer'|'queued-buy'|'queued-sell';price:number;quantity:number|null;reserved:number|null};
export type Holding={key:string;slug:string;game:string;team:string;side:'YES'|'NO';quantity:number;averagePrice:number;cost:number;value:number|null;result:number|null;
  policy:'offer fill'|'hold to final'|'drive'|'managed';partial:boolean;
  /** Offer-fill shares with no matching fill on the other team: sold at the best bid at this time if still unpaired. */
  sellBy:number|null;paired:boolean;
  /** Bold keeps unpaired shares: it still tries to pair, may buy once more on a dip, else holds to the final. */
  boldHold:boolean};

const exact=(x:number)=>Math.round(x*1e6)/1e6;

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
  if(pending)orders.push({key:`queued:${pending.id}`,slug:pending.slug,game:game(pending.slug),team:team(pending.slug,pending.side),side:pending.side,
    kind:pending.action==='BUY'?'queued-buy':'queued-sell',price:pending.limitPrice,quantity:null,reserved:pending.action==='BUY'?pending.budget??null:null});
  const makerQty=(slug:string,side:'YES'|'NO')=>session.positions.filter(p=>p.status==='open'&&p.exitPolicy==='maker'&&p.slug===slug&&p.side===side).reduce((sum,p)=>sum+p.quantity,0);
  const holdings:Holding[]=session.positions.filter(p=>p.status==='open').map(p=>{
    const mine=p.exitPolicy==='maker'?makerQty(p.slug,p.side):0,theirs=p.exitPolicy==='maker'?makerQty(p.slug,p.side==='YES'?'NO':'YES'):0;
    const paired=p.exitPolicy==='maker'&&theirs>0&&mine<=theirs+1e-9,unpairedSide=p.exitPolicy==='maker'&&mine>theirs+1e-9;
    const marked=p.netLiquidationValue!==null&&!!p.markedAt&&now-p.markedAt<=15_000;
    return {key:p.id,slug:p.slug,game:game(p.slug),team:team(p.slug,p.side)||p.name,side:p.side,quantity:p.quantity,averagePrice:p.entryPrice,cost:p.costBasis,
      value:marked?p.netLiquidationValue:null,result:marked?exact(p.netLiquidationValue!-p.costBasis):null,
      policy:p.exitPolicy==='maker'?'offer fill':p.exitPolicy==='hold-to-settlement'?'hold to final':p.exitPolicy==='drive'?'drive':'managed',
      partial:marked&&p.liquidationQuantity+1e-7<p.quantity,sellBy:unpairedSide&&modeOf(session.config)==='steady'?p.openedAt+PAIR_WINDOW_MS:null,paired,boldHold:unpairedSide&&modeOf(session.config)==='bold'};
  });
  return {orders,holdings,reserved:exact(orders.reduce((sum,o)=>sum+(o.reserved??0),0)),held:exact(holdings.reduce((sum,h)=>sum+h.cost,0))};
}
