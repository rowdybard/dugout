import type {Market} from '../market/types';
import type {BotInput} from './types';
import type {SportsContext} from '../sports-context/types';
import {cached} from '../server/storage';
import {book,metadata,numeric,settlement} from '../server/polymarket';
import {getSportsContext} from '../sports-context/server';
import {replayData} from '../server/replay';
import model from '../../data/models/mlb-elo-2026-09-23.json';
import {forecastInput} from './forecast-input';
import {abortable} from '../server/request-budget';
import {recordTradingObservation} from '../server/trading';
import {currentStreamBook} from '../server/stream-books';
import {nflReferenceInput} from './nfl-reference';

/** Reference/context I/O finishes before the executable snapshot is fetched. */
export async function loadBotInput(market:Market,held=false,signal:AbortSignal=AbortSignal.timeout(22000)):Promise<BotInput>{
  signal.throwIfAborted();
  const noContext:SportsContext={slug:market.slug,league:market.league,status:'unavailable',receivedAt:Date.now(),source:{name:'Exit check',url:'https://docs.polymarket.us',support:'official'},game:null,players:[],changes:[],injuryStatus:'not_verified',limitations:['Sports entry vetoes do not prevent exits.']};
  // Sports may veto an entry, but a slow report must leave time to observe the market.
  const sportsSignal=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  const [meta,context,replay]=await abortable(Promise.all([cached(`bot:metadata:${market.slug}`,120000,()=>metadata(market.slug,signal)),held?Promise.resolve(noContext):getSportsContext(market,sportsSignal),replayData()]),signal);
  signal.throwIfAborted();
  const minimum=numeric(meta.minimumTradeQty),tick=numeric(meta.orderPriceMinTickSize),fee=numeric(meta.feeCoefficient);
  if(minimum===null||minimum<=0||tick===null||tick<=0||tick>=1||fee===null||fee<0)throw new Error('Verified quantity, price tick, or fee metadata is missing.');
  const live=!replay?await currentStreamBook(market.slug).catch(()=>null):null;
  const depth=live?.book??await book(market.slug,signal),receivedAt=live?.receivedAt??Date.now();
  const settled=!replay&&held&&depth.state!=='MARKET_STATE_OPEN'?await settlement(market.slug,signal):null;
  signal.throwIfAborted();
  const source=replay?'REPLAY':live?'WEBSOCKET':'REST';
  await recordTradingObservation(market.slug,depth,source,receivedAt).catch(()=>{});
  return {market:{...market,fee},executionMarket:{slug:market.slug,league:market.league,active:depth.state==='MARKET_STATE_OPEN',minimumTradeQty:minimum,quantityIncrement:minimum,priceIncrement:tick,feeCoefficient:fee},book:depth,receivedAt,source,context,settlement:settled,settlementReceivedAt:settled===null?undefined:Date.now(),forecast:held?undefined:market.league==='NFL'?nflReferenceInput(market,context,meta,Date.now()):forecastInput(model,market,context,meta,Date.now())};
}
