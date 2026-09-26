import type {TennisMarket,TennisPricePoint,TennisSession} from './types';
const validPrice=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
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

/** A real book can refresh prices, never the catalog's live/score timestamp. */
export function marketWithSessionQuotes(market:TennisMarket,session:TennisSession|null):TennisMarket{
  const quote=session?.quotes?.[market.slug];
  const useBook=quote&&quote.time>=(market.quoteObservedAt??market.observedAt);
  const current=useBook?{...market,bid:quote.bid,ask:quote.ask,price:quote.bid!==null&&quote.ask!==null?(quote.bid+quote.ask)/2:null,quoteObservedAt:quote.time,quoteSource:quote.source}:market;
  const point=useBook&&current.price!==null?[{time:quote.time,price:current.price,bid:quote.bid??undefined,ask:quote.ask??undefined}]:[];
  return {...current,history:mergeTennisHistory(market.history,session?.histories[`${market.slug}:YES`]??[],point)};
}
export function chartFills(session:TennisSession|null,slug:string,side:'YES'|'NO',start:number,end:number){
  return (session?.ledger??[]).filter(entry=>entry.slug===slug&&entry.side===side&&entry.source==='AUTOMATIC'&&entry.execution?.apply&&entry.execution.filledQty>0&&entry.time>=start&&entry.time<=end&&['BUY','SELL'].includes(entry.action))
    .map(entry=>({...entry,price:entry.actualPrice??entry.execution!.averagePrice})).filter(entry=>validPrice(entry.price));
}
