import {publicGet,publicMarketBook} from '../server/polymarket';
import {cached,db,readCached} from '../server/storage';
import {currentStreamBook} from '../server/stream-books';
import {sourceError} from '../server/request-budget';
import {freshTennisBook,normalizeTennisBook,normalizeTennisEvent,normalizeTennisExecution,normalizeTennisSettlement} from './normalize';
import {currentTennisContext,retainedTennisContext} from './market-context';
import {CHART_HISTORY_SQL} from './chart-rejections';
import {loadTennisCatalog,boundedCatalogOperation} from './catalog-loader';
import type {TennisCatalog,TennisInput,TennisLeague,TennisMarket,TennisPricePoint} from './types';

const CATALOG_DEADLINE=5500;
const BOOK_TTL=1_000;
type ObservedBook=Pick<TennisInput,'book'|'receivedAt'|'source'|'sourceTime'|'restReceipt'>;

async function displayHistory(slug:string,rejectedTimes:number[]=[]):Promise<TennisPricePoint[]>{
  // These are captured quotes, never hypothetical fills or a reconstructed sports score.
  const rows=await db().prepare(CHART_HISTORY_SQL)
    .bind(slug,Date.now()-6*60*60_000,JSON.stringify(rejectedTimes)).all<{time:number;bid:number;ask:number;score:string|null;period:string|null;scoreUpdatedAt:number|null}>().catch(()=>({results:[]}));
  return rows.results.flatMap(row=>{
    try{
      const {bid,ask}=row;
      if(!Number.isFinite(row.time)||!Number.isFinite(bid)||!Number.isFinite(ask)||bid<0||ask>1||bid>ask)return [];
      return [{time:row.time,price:(bid+ask)/2,spread:ask-bid,bid,ask,score:row.score,period:row.period,scoreUpdatedAt:row.scoreUpdatedAt}];
    }catch{return [];}
  }).reverse();
}

/** Catalog writes are request-owned; do not join the generic cross-request cache promise map. */
async function persistCatalogCache(key:string,value:unknown,expectedUpdated:number|null,fresh:TennisMarket[]=[]):Promise<boolean>{
  const serialized=JSON.stringify(value);
  if(serialized.length>8_000_000)throw new Error('The discovery checkpoint exceeded its storage budget. Showing the saved list.');
  const updated=Math.max(Date.now(),(expectedUpdated??0)+1),statements:D1PreparedStatement[]=[];
  for(const market of fresh)statements.push(db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE excluded.updated>=cache.updated')
    .bind(`tennis:verified:${market.slug}`,JSON.stringify(market),market.observedAt));
  let payload=serialized;
  if(serialized.length>400000){
    const generation=crypto.randomUUID(),parts=[];
    for(let i=0;i<serialized.length;i+=400000)parts.push(serialized.slice(i,i+400000));
    for(const [index,part] of parts.entries())statements.push(db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?)').bind(`${key}:part:${generation}:${index}`,part,updated));
    payload=JSON.stringify({__chunks:parts.length,generation});
  }
  const checkpoint=expectedUpdated===null
    ?db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,payload,updated)
    :db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE cache.updated=?').bind(key,payload,updated,expectedUpdated);
  statements.push(checkpoint);
  const results=await db().batch(statements);
  return !!results.at(-1)?.meta.changes;
}

/** Resume at most two pages per league, inside one budget that includes cache I/O. */
export async function getTennisCatalog({includeHistory=true,leagues=['ATP','WTA'],rejectedBooks={},signal}:{includeHistory?:boolean;leagues?:TennisLeague[];rejectedBooks?:Record<string,number[]>;signal?:AbortSignal}={}):Promise<TennisCatalog>{
  const deadlineAt=Date.now()+CATALOG_DEADLINE;
  const catalog=await loadTennisCatalog(leagues,{
    now:Date.now,read:readCached,
    writeLeague:(key,state,expectedUpdated,fresh)=>persistCatalogCache(key,state,expectedUpdated,fresh),
    writeCatalog:(key,value,expectedUpdated)=>persistCatalogCache(key,value,expectedUpdated),
    eventKey:event=>{const raw=event as {id?:unknown;slug?:unknown};return typeof raw?.id==='string'||typeof raw?.id==='number'?String(raw.id):typeof raw?.slug==='string'?raw.slug:'';},
    normalize:(event,sport,observedAt)=>normalizeTennisEvent(event,sport as TennisLeague,observedAt),
    fetchPage:async(sport,{offset,limit,signal})=>{
      const raw=await publicGet(`/v2/leagues/${sport.toLowerCase()}/events?type=sport&limit=${limit}&offset=${offset}`,signal);
      if(!Array.isArray(raw.events))throw new Error('League response has no events list.');
      return raw.events;
    },
  },signal);
  const markets=catalog.markets.map(m=>({...m,rejectedQuoteTimes:rejectedBooks[m.slug]??[]}));
  if(!includeHistory)return {...catalog,markets};
  try{
    const histories=await boundedCatalogOperation(()=>Promise.all(markets.map(async market=>({...market,history:await displayHistory(market.slug,rejectedBooks[market.slug])}))),deadlineAt,Date.now,signal);
    return {...catalog,markets:histories};
  }catch(error){return {...catalog,markets,errors:[...catalog.errors,sourceError(error,'Chart history is waiting for storage.')]};}
}
export async function getTennisMarket(slug:string,leagues:TennisLeague[]=['ATP','WTA'],rejectedTimes:number[]=[],includeHistory=false):Promise<TennisMarket>{
  if(typeof slug!=='string'||slug.length>200||!/^[-a-zA-Z0-9]+$/.test(slug))throw new Error('Choose a verified game market.');
  const current=(await getTennisCatalog({includeHistory:false,leagues})).markets.find(m=>m.slug===slug);
  if(current)return {...current,rejectedQuoteTimes:rejectedTimes,history:includeHistory?await displayHistory(slug,rejectedTimes):[]};
  const previous=await readCached<TennisMarket>(`tennis:verified:${slug}`);
  if(!previous||previous.value.slug!==slug||!['ATP','WTA','NFL','CFB'].includes(previous.value.league))throw new Error('This match is not in the verified tennis/football winner catalog.');
  return {...previous.value,active:false,rejectedQuoteTimes:rejectedTimes,history:await displayHistory(slug,rejectedTimes),unavailableReason:'Match is no longer in the active catalog. New entries are blocked; held positions can still be checked.'};
}

async function refreshedRules(market:TennisMarket,signal?:AbortSignal):Promise<TennisMarket>{
  if(Date.now()-market.observedAt<=60_000)return market;
  const raw=await cached(`tennis:metadata:${market.slug}`,30_000,async()=>{
    const response=await publicGet(`/v1/market/slug/${encodeURIComponent(market.slug)}`,signal);
    return response.market??response;
  });
  const execution=normalizeTennisExecution(raw,market.league as TennisLeague);
  if(!execution||execution.slug!==market.slug)return {...market,active:false,execution:null,unavailableReason:'Current exchange order rules could not be verified.'};
  return {...market,active:market.active&&execution.active,execution};
}

async function confirmedSettlement(market:TennisMarket,signal?:AbortSignal):Promise<number|null>{
  // No calls for ordinary active matches. Zero in book.stats is not settlement evidence.
  if(!market.ended&&market.execution?.active!==false)return null;
  return cached(`tennis:settlement:${market.slug}`,30_000,async()=>{
    try{return normalizeTennisSettlement(await publicGet(`/v1/markets/${encodeURIComponent(market.slug)}/settlement`,signal),market.slug);}
    catch(error){
      // The shared source budget wraps non-429 HTTP errors with this exact wording.
      if((error as {status?:number})?.status===404||error instanceof Error&&error.message==='Polymarket US returned HTTP 404. No current quote was accepted.')return null;
      throw error;
    }
  });
}

/** REST can be disabled for scan candidates, preserving the per-tick request budget. */
export async function loadTennisInput(market:TennisMarket,signal?:AbortSignal,options:{allowRest?:boolean;lastContext?:TennisMarket}={}):Promise<TennisInput>{
  signal?.throwIfAborted();
  // Stored mapping is trusted only because the server obtained it from the strict catalog.
  if(!['ATP','WTA','NFL','CFB'].includes(market.league)||!market.slug)throw new Error('Unsupported paper market.');
  const allowRest=options.allowRest!==false;
  // The visible catalog already refreshes this verified cache. Reading it keeps
  // held-match context current without a slow discovery call on the exit path.
  const now=Date.now();
  const latest=allowRest&&now-market.observedAt>30_000?await readCached<TennisMarket>(`tennis:verified:${market.slug}`).catch(()=>null):null;
  // Retain the original mapping's age for independent exchange metadata checks.
  const rules=allowRest?await refreshedRules(market,signal):market;
  const retained=retainedTennisContext(rules,options.lastContext,now);
  const verified=currentTennisContext(retained,latest?.value,now,rules.active);
  const streamed=await currentStreamBook(market.slug);
  let observed:ObservedBook|null=streamed&&freshTennisBook(streamed.receivedAt,Date.now())?streamed:null;
  if(!observed&&!allowRest){
    const stored=await readCached<ObservedBook>(`tennis:book:v2:${market.slug}`),now=Date.now();
    if(stored&&stored.value.source==='REST'&&freshTennisBook(stored.value.receivedAt,now))observed=stored.value;
    if(!observed)throw new Error('Waiting for a fresh game book; REST checks rotate through live games.');
  }
  const settlement=allowRest?await confirmedSettlement(verified,signal):null;
  if(!observed){
    try{
      observed=await cached<ObservedBook>(`tennis:book:v2:${market.slug}`,BOOK_TTL,async()=>{
        const {data,receipt}=await publicMarketBook(market.slug,signal);
        // Request start is conservative; response latency cannot rejuvenate a quote.
        return {book:normalizeTennisBook(data,market.slug),receivedAt:receipt.requestedAt,source:'REST',restReceipt:receipt};
      });
    }catch(error){
      if(settlement===null)throw error;
      // Final settlement still reconciles a position after the provider removes its book.
      observed={book:{bids:[],asks:[],state:'MARKET_STATE_EXPIRED',time:''},receivedAt:Date.now(),source:'REST'};
    }
  }
  const {book,receivedAt,source,restReceipt}=observed;
  // WS display time can fall back to receipt time; it must never become provider time.
  const restTime=source==='REST'?Date.parse(book.time):NaN;
  const sourceTime=source==='REST'?(Number.isFinite(restTime)?restTime:null):observed.sourceTime??null;
  const bid=book.bids[0]?.price??null,ask=book.asks[0]?.price??null;
  return {market:{...verified,bid,ask,price:bid!==null&&ask!==null?(bid+ask)/2:null,quoteObservedAt:receivedAt,quoteSource:source},book,receivedAt,source,sourceTime,...(restReceipt?{restReceipt}:{}),
    settlement,...(settlement!==null?{settlementReceivedAt:Date.now()}:{} )};
}
