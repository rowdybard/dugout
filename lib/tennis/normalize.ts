import type {Book} from '../market/types';
import type {ExecutionMarket} from '../trading/types';
import type {TennisLeague,TennisMarket} from './types';

/** Only fields verified against the Polymarket US retail schema are consumed. */
type Raw=Record<string,unknown>;
const object=(value:unknown):Raw=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Raw:{};
const list=(value:unknown):Raw[]=>Array.isArray(value)?value.map(object):[];
const string=(value:unknown):string=>typeof value==='string'?value.trim():'';
export function tennisNumber(value:unknown):number|null{
  if(typeof value!=='number'&&typeof value!=='string')return null;
  if(typeof value==='string'&&!value.trim())return null;
  const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;
}
const timestamp=(value:unknown):number|null=>{const parsed=Date.parse(string(value));return Number.isFinite(parsed)?parsed:null;};
const price=(value:unknown):number|null=>{const n=tennisNumber(object(value).value);return n!==null&&n>=0&&n<=1?n:null;};
const decimal=(value:number)=>Number.isSafeInteger(Math.round(value*1e6))&&Math.abs(value*1e6-Math.round(value*1e6))<0.00001;

/** Match the paper engine's quote budget; transport heartbeats never extend it. */
export function freshTennisBook(receivedAt:number,now:number,maxAgeMs=5000):boolean{
  return Number.isFinite(receivedAt)&&Number.isFinite(now)&&Number.isFinite(maxAgeMs)&&maxAgeMs>0&&receivedAt<=now&&now-receivedAt<=maxAgeMs;
}

/** No fee/tick/minimum defaults: missing rules must block simulated execution. */
export function normalizeTennisExecution(raw:unknown,league:TennisLeague):ExecutionMarket|null{
  const market=object(raw),slug=string(market.slug);
  const minimum=tennisNumber(market.minimumTradeQty),tick=tennisNumber(market.orderPriceMinTickSize),fee=tennisNumber(market.feeCoefficient);
  if(!slug||market.sportsMarketType!=='tennis_match_winner'||minimum===null||minimum<=0||tick===null||tick<=0||tick>=1||fee===null||fee<0||fee>1||![minimum,tick,fee].every(decimal))return null;
  return {slug,league,active:market.active===true&&market.closed!==true&&market.archived!==true&&market.hidden!==true
    &&market.status==='MARKET_STATUS_OPEN',minimumTradeQty:minimum,quantityIncrement:minimum,priceIncrement:tick,feeCoefficient:fee};
}

/** YES/NO mapping uses explicit long flags, never title order or listing prices. */
export function normalizeTennisEvent(raw:unknown,league:TennisLeague,observedAt:number):TennisMarket[]{
  const event=object(raw),eventId=typeof event.id==='number'?String(event.id):string(event.id),eventSlug=string(event.slug);
  if(!eventId||!eventSlug||!Number.isFinite(observedAt)||event.hidden===true||event.archived===true)return [];
  const state=object(event.eventState),tennis=object(state.tennisState);
  const tournament=string(tennis.tournamentName)||null;
  if(/doubles|mixed/i.test(tournament??'')||/doubles|mixed/i.test(string(event.title)))return [];
  const result:TennisMarket[]=[];
  for(const market of list(event.markets)){
    if(market.sportsMarketType!=='tennis_match_winner'||market.hidden===true||market.archived===true)continue;
    const slug=string(market.slug),sides=list(market.marketSides);
    const yes=sides.filter(s=>s.long===true),no=sides.filter(s=>s.long===false);
    if(!slug||yes.length!==1||no.length!==1||sides.length!==2)continue;
    const yesName=string(yes[0].description),noName=string(no[0].description);
    if(!yesName||!noName||yesName===noName||/[\/]/.test(yesName+noName))continue;
    // The league endpoint supplies the league; embedded participant leagues may not contradict it.
    if(sides.some(side=>{const sideLeague=string(object(side.team).league);return sideLeague&&sideLeague.toUpperCase()!==league;}))continue;
    const startTime=string(event.startTime)||string(market.gameStartTime),start=timestamp(startTime);
    const live=event.live===true,ended=event.ended===true||state.ended===true||event.closed===true;
    const period=string(event.period)||string(state.period)||null;
    const interrupted=/sus|delay|postpon|cancel|retir|walkover|abandon|interrupt/i.test(period??'');
    const execution=normalizeTennisExecution(market,league);
    const validPhase=!ended&&!interrupted&&(live||(event.live===false&&start!==null&&start>observedAt));
    const active=event.active===true&&execution?.active===true&&validPhase;
    const bid=price(market.bestBidQuote),ask=price(market.bestAskQuote);
    const unavailableReason=!execution?'Exchange fee or order-size rules are missing.'
      :ended?'Match has ended; waiting for official settlement.'
      :interrupted?'Match is suspended or interrupted. New entries are blocked.'
      :!validPhase?'Match live status is unconfirmed. New entries are blocked.'
      :!execution.active||event.active!==true?'Market is not accepting new trades.':undefined;
    result.push({slug,eventId,eventSlug,title:string(event.title)||`${yesName} vs ${noName}`,league,
      yesName,noName,startTime,live,ended,score:string(event.score)||string(state.score)||null,period,tournament,
      active,bid,ask,price:bid!==null&&ask!==null&&bid<=ask?(bid+ask)/2:null,
      observedAt,quoteObservedAt:observedAt,quoteSource:'CATALOG',contextUpdatedAt:timestamp(state.updatedAt),history:[],execution,unavailableReason});
  }
  return result;
}

/** A malformed level rejects the whole snapshot; it is never silently removed. */
export function normalizeTennisBook(raw:unknown,slug:string):Book{
  const market=object(object(raw).marketData);
  if(market.marketSlug!==slug||!Array.isArray(market.bids)||!Array.isArray(market.offers)||!string(market.state))throw new Error('Polymarket US returned an unverified tennis order book.');
  const levels=(rawLevels:unknown[]):Book['bids']=>{
    if(rawLevels.length>1000)throw new Error('Tennis order book exceeds the supported depth.');
    return rawLevels.map(rawLevel=>{
      const level=object(rawLevel),p=price(level.px),quantity=tennisNumber(level.qty);
      if(p===null||p<=0||p>=1||quantity===null||quantity<0||!decimal(p)||!decimal(quantity))throw new Error('Polymarket US returned a malformed tennis order book level.');
      return {price:p,quantity};
    }).filter(level=>level.quantity>0);
  };
  const bids=levels(market.bids).sort((a,b)=>b.price-a.price),asks=levels(market.offers).sort((a,b)=>a.price-b.price);
  if(bids[0]&&asks[0]&&bids[0].price>asks[0].price)throw new Error('Tennis order book is crossed; waiting for a consistent snapshot.');
  return {bids,asks,state:string(market.state),time:string(market.transactTime)};
}

/** The settlement endpoint may return a fair-price settlement, not only 0 or 1. */
export function normalizeTennisSettlement(raw:unknown,slug:string):number|null{
  const data=object(raw),value=tennisNumber(data.settlement);
  return data.slug===slug&&value!==null&&value>=0&&value<=1?value:null;
}
