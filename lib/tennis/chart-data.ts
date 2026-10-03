import type {TennisInput,TennisMarket,TennisPricePoint,TennisSession} from './types';
import type {StreamQuote} from '../trading/stream-types';
import {bookOrderIssue} from './book-order.ts';
import {CLOCK_SKEW_MS} from './decision-view.ts';

/** Independent play reports may update the field, never the book's receipt time or chart evidence. */
export function marketWithWatchedContext(stored:TennisMarket,latest:TennisMarket,now:number):TennisMarket {
  const oldDrive=stored.footballSources?.drive,newDrive=latest.footballSources?.drive;
  const newerDrive=!!newDrive&&Number.isFinite(newDrive.reportTime)&&newDrive.reportTime>=0&&Number.isFinite(newDrive.receiptTime)&&newDrive.reportTime<=newDrive.receiptTime&&newDrive.receiptTime<=now+CLOCK_SKEW_MS&&
    (!oldDrive||oldDrive.provider!==newDrive.provider||oldDrive.eventId!==newDrive.eventId||newDrive.receiptTime>=oldDrive.receiptTime&&
      (newDrive.reportTime>oldDrive.reportTime||newDrive.reportTime===oldDrive.reportTime&&typeof newDrive.sequence==='number'&&typeof oldDrive.sequence==='number'&&newDrive.sequence>oldDrive.sequence));
  const sourceIssueChanged=latest.footballSourceIssue!==stored.footballSourceIssue;
  // Discovery may arrive later with an older play. Provider time wins; receipt only breaks ties.
  // This field display uses the device clock; a small server-clock lead must not freeze its facts.
  if(latest.slug!==stored.slug||latest.league!==stored.league||latest.eventId!==stored.eventId||latest.yesName!==stored.yesName||latest.noName!==stored.noName||
    stored.footballIdentity&&(!latest.footballIdentity||latest.footballIdentity.yesTeamId!==stored.footballIdentity.yesTeamId||latest.footballIdentity.noTeamId!==stored.footballIdentity.noTeamId)||
    !Number.isFinite(latest.observedAt)||latest.observedAt>now+CLOCK_SKEW_MS||latest.contextUpdatedAt===null||!Number.isFinite(latest.contextUpdatedAt)||latest.contextUpdatedAt>latest.observedAt||
    stored.contextUpdatedAt!==null&&(latest.contextUpdatedAt<stored.contextUpdatedAt||latest.contextUpdatedAt===stored.contextUpdatedAt&&(latest.observedAt<stored.observedAt||latest.observedAt===stored.observedAt&&!newerDrive&&!sourceIssueChanged)))return stored;
  return {...stored,live:latest.live,ended:latest.ended,active:stored.active&&stored.execution?.active===true&&latest.active,
    score:latest.score,period:latest.period,clock:latest.clock,football:latest.football,footballIdentity:latest.footballIdentity,footballSources:latest.footballSources,footballSourceIssue:latest.footballSourceIssue,tournament:latest.tournament,
    observedAt:latest.observedAt,contextUpdatedAt:latest.contextUpdatedAt};
}
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

/** The watched-book endpoint is display-only, with the same age/order evidence as a bot check. */
export function watchedBookIssue(input:TennisInput,session:TennisSession|null,now:number,market?:TennisMarket):string|null{
  if(!input?.market||!input.book||!['REST','WEBSOCKET'].includes(input.source))return 'Waiting for a verified live book.';
  if(market&&(input.market.slug!==market.slug||input.market.league!==market.league||input.market.eventId!==market.eventId||input.market.yesName!==market.yesName||input.market.noName!==market.noName))return 'This quote belongs to a different game.';
  const ageLimit=Math.min(5000,session?.config.maxBookAgeMs??5000);
  if(!Number.isFinite(now)||!Number.isFinite(input.receivedAt)||input.receivedAt>now||now-input.receivedAt>ageLimit)return 'The selected game book is stale. Checking again.';
  if(input.source==='REST'){
    const receipt=input.restReceipt;
    if(!receipt||!Number.isFinite(receipt.requestedAt)||!Number.isFinite(receipt.receivedAt)||receipt.requestedAt!==input.receivedAt||receipt.receivedAt<receipt.requestedAt||receipt.receivedAt>now||!['MISS','BYPASS','DYNAMIC'].includes(receipt.cacheStatus)||(receipt.cacheAgeSeconds!==null&&receipt.cacheAgeSeconds!==0))return 'The selected game book has no verified fresh REST receipt.';
  }
  const previous=Math.max(market?.quoteSourceTime??-Infinity,session?.bookSourceTimes?.[input.market.slug]??-Infinity,session?.quotes?.[input.market.slug]?.sourceTime??-Infinity);
  const ordering=bookOrderIssue(input,Number.isFinite(previous)?previous:undefined,now);if(ordering)return ordering;
  const previousReceipt=Math.max(market&&['REST','WEBSOCKET'].includes(market.quoteSource??'')?market.quoteObservedAt??0:0,session?.quotes?.[input.market.slug]?.time??0);
  if(input.receivedAt<previousReceipt)return 'A newer game book has already arrived.';
  const rejected=new Set([...(market?.rejectedQuoteTimes??[]),...(session?.decisions??[]).filter(d=>d.slug===input.market.slug&&d.code==='BOOK_ORDER').map(d=>d.bookTime)]);
  if(rejected.has(input.receivedAt))return 'This book was already rejected. Waiting for a fresh quote.';
  const {bids,asks}=input.book;
  if(!Array.isArray(bids)||!Array.isArray(asks)||!bids.length||!asks.length||[...bids,...asks].some(level=>!validPrice(level.price)||!Number.isFinite(level.quantity)||level.quantity<0)||bids[0].quantity<=0||asks[0].quantity<=0||bids.some((level,i)=>i>0&&level.price>bids[i-1].price)||asks.some((level,i)=>i>0&&level.price<asks[i-1].price)||bids[0].price>asks[0].price)return 'The selected game book has incomplete or invalid quotes.';
  return null;
}

/** Refresh prices using actual receipt time; never rejuvenate score or game-status metadata. */
export function marketWithWatchedBook(market:TennisMarket,input:TennisInput,session:TennisSession|null,now:number):TennisMarket{
  if(watchedBookIssue(input,session,now,market))return market;
  const bid=input.book.bids[0].price,ask=input.book.asks[0].price,price=(bid+ask)/2;
  return marketWithSessionQuotes({...market,bid,ask,price,quoteObservedAt:input.receivedAt,quoteSource:input.source,quoteSourceTime:input.sourceTime,
    history:mergeTennisHistory(market.history,[{time:input.receivedAt,price,bid,ask,score:market.score,period:market.period,scoreUpdatedAt:market.contextUpdatedAt}])},session);
}
export function chartFills(session:TennisSession|null,slug:string,side:'YES'|'NO',start:number,end:number){
  return (session?.ledger??[]).filter(entry=>entry.slug===slug&&entry.side===side&&entry.source==='AUTOMATIC'&&entry.execution?.apply&&entry.execution.filledQty>0&&entry.time>=start&&entry.time<=end&&['BUY','SELL'].includes(entry.action))
    .map(entry=>({...entry,price:entry.actualPrice??entry.execution!.averagePrice})).filter(entry=>validPrice(entry.price));
}
