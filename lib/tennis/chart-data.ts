import type {TennisMarket,TennisPricePoint,TennisSession} from './types';
import type {StreamQuote} from '../trading/stream-types';
import {bookOrderIssue} from './book-order.ts';
const validPrice=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
export function quoteMidpoint(bid:number|null,ask:number|null):number|null{return validPrice(bid)&&validPrice(ask)&&bid<=ask?(bid+ask)/2:null;}
/** Display clocks can differ slightly; execution still uses the strict server clock. */
export function quoteFreshForDisplay(time:number,now:number,maxAgeMs:number):boolean{
  return Number.isFinite(time)&&Number.isFinite(now)&&maxAgeMs>0&&Math.abs(now-time)<=maxAgeMs;
}
export function mergeTennisHistory(...sources:TennisPricePoint[][]):TennisPricePoint[]{
  const rows=new Map<number,TennisPricePoint>();
  for(const points of sources)for(const point of points){
    if(!Number.isFinite(point.time)||!validPrice(point.price))continue;
    const defined=Object.fromEntries(Object.entries(point).filter(([,value])=>value!==undefined));
    rows.set(point.time,{...rows.get(point.time),...defined} as TennisPricePoint);
  }
  return [...rows.values()].sort((a,b)=>a.time-b.time).slice(-1200);
}
export function outcomeHistory(points:TennisPricePoint[],side:'YES'|'NO'){
  return points.map(point=>{
    const pair=validPrice(point.bid)&&validPrice(point.ask)&&point.bid<=point.ask;
    const bid=pair?point.bid:undefined,ask=pair?point.ask:undefined;
    return {...point,price:side==='YES'?point.price:1-point.price,
      bid:side==='YES'?bid:ask===undefined?undefined:1-ask,
      ask:side==='YES'?ask:bid===undefined?undefined:1-bid};
  });
}
export function withQuoteGaps(points:TennisPricePoint[],gapMs=30_000){
  const result:Array<Omit<TennisPricePoint,'price'|'bid'|'ask'>&{price:number|null;bid?:number|null;ask?:number|null}>=[];
  points.forEach((point,i)=>{
    if(i&&point.time-points[i-1].time>gapMs)result.push({time:points[i-1].time+1,price:null,bid:null,ask:null});
    result.push(point);
  });
  return result;
}
export function quoteGaps(points:TennisPricePoint[],gapMs=30_000){
  return points.flatMap((point,i)=>i&&point.time-points[i-1].time>gapMs?[{from:points[i-1],to:point}]:[]);
}

/** A real book can refresh prices, never the catalog's live/score timestamp. */
export function marketWithSessionQuotes(market:TennisMarket,session:TennisSession|null):TennisMarket{
  const rejected=new Set([...(market.rejectedQuoteTimes??[]),...(session?.decisions??[]).filter(d=>d.slug===market.slug&&d.code==='BOOK_ORDER'&&d.bookTime!==undefined).map(d=>d.bookTime!)]);
  const quote=session?.quotes?.[market.slug];
  const rejectedCurrent=rejected.has(market.quoteObservedAt??market.observedAt);
  const useBook=quote&&!rejected.has(quote.time)&&(quote.time>=(market.quoteObservedAt??market.observedAt)||rejectedCurrent);
  const current=useBook?{...market,bid:quote.bid,ask:quote.ask,price:quote.bid!==null&&quote.ask!==null?(quote.bid+quote.ask)/2:null,quoteObservedAt:quote.time,quoteSource:quote.source,quoteSourceTime:quote.sourceTime}:rejectedCurrent?{...market,bid:null,ask:null,price:null,quoteObservedAt:0}:market;
  const point=useBook&&current.price!==null?[{time:quote.time,price:current.price,bid:quote.bid??undefined,ask:quote.ask??undefined}]:[];
  return {...current,history:mergeTennisHistory(...[market.history,session?.histories[`${market.slug}:YES`]??[],point].map(points=>points.filter(point=>!rejected.has(point.time))))};
}

/** Keep the fast visible stream without allowing a reconnect to roll prices backward. */
export function marketWithStreamQuote(market:TennisMarket,quote:StreamQuote,session:TennisSession|null,now:number):TennisMarket{
  if(market.slug!==quote.slug||!quote.valid||quote.source!=='polymarket_us_websocket'||
    !quoteFreshForDisplay(quote.receivedAt,now,session?.config.maxBookAgeMs??5000)||
    quote.receivedAt<(market.quoteObservedAt??market.observedAt))return market;
  const previous=Math.max(market.quoteSourceTime??-Infinity,session?.bookSourceTimes?.[market.slug]??-Infinity);
  if(bookOrderIssue({sourceTime:quote.sourceTime},Number.isFinite(previous)?previous:undefined,now))return market;
  const midpoint=quoteMidpoint(quote.bid,quote.ask),points=[...market.history];
  if(midpoint!==null&&(!points.length||quote.receivedAt-points.at(-1)!.time>=1000))points.push({time:quote.receivedAt,price:midpoint,bid:quote.bid??undefined,ask:quote.ask??undefined,score:market.score,period:market.period,scoreUpdatedAt:market.contextUpdatedAt});
  return marketWithSessionQuotes({...market,bid:quote.bid,ask:quote.ask,price:midpoint,quoteObservedAt:quote.receivedAt,quoteSource:'WEBSOCKET',quoteSourceTime:quote.sourceTime,history:points.slice(-1200)},session);
}
export function chartFills(session:TennisSession|null,slug:string,side:'YES'|'NO',start:number,end:number){
  return (session?.ledger??[]).filter(entry=>entry.slug===slug&&entry.side===side&&entry.source==='AUTOMATIC'&&entry.execution?.apply&&entry.execution.filledQty>0&&entry.time>=start&&entry.time<=end&&['BUY','SELL'].includes(entry.action))
    .map(entry=>({...entry,price:entry.actualPrice??entry.execution!.averagePrice})).filter(entry=>validPrice(entry.price));
}
