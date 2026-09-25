import {PolymarketUS} from 'polymarket-us';
import type {Market,League,Book} from '../../lib/market/types';
import type {SportsContext,ScheduleGame} from '../../lib/sports-context/types';
import type {BotInput} from '../../lib/bot/types';
import {mlbSchedule,mlbContext} from '../../lib/sports-context/mlb.ts';
import {nflSchedule,nflContext} from '../../lib/sports-context/nfl.ts';
import {dateKeys,matchingGame} from '../../lib/sports-context/shared.ts';
import {reportedInjuries} from '../../lib/sports-context/injuries.ts';
import model from '../../data/models/mlb-elo-2026-09-23.json' with {type:'json'};
import {createPublicSourceBudget} from '../../lib/bot/public-source-budget.ts';
import {forecastInput} from '../../lib/bot/forecast-input.ts';

// Public read-only API transport. There is no authenticated trading client here.
type Raw=Record<string,any>;
const sourceBudget=createPublicSourceBudget();
export const sourceBackoffUntil=()=>sourceBudget.blockedUntil();
export const restoreSourceBackoff=(until:number)=>sourceBudget.deferUntil(until);
const sdk=new PolymarketUS({timeout:12000}), cache=new Map<string,{time:number;value:unknown}>();
const number=(v:unknown):number|null=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
async function json(url:string):Promise<Raw>{const r=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!r.ok){const error=Object.assign(new Error(`Source returned ${r.status}`),{status:r.status,retryAfterMs:Math.max(0,Number(r.headers.get('Retry-After'))*1000)});throw error;};return r.json() as Promise<Raw>;}
async function cached<T>(key:string,ttl:number,load:()=>Promise<T>):Promise<T>{const old=cache.get(key);if(old&&Date.now()-old.time<ttl)return old.value as T;const value=await load();cache.set(key,{time:Date.now(),value});return value;}
export async function discoverMarkets(leagues:League[]):Promise<Market[]>{
  const markets:Market[]=[];
  for(const league of leagues)for(let offset=0;offset<24;offset+=4){
    const page=await sourceBudget.run(()=>json(`https://gateway.polymarket.us/v2/leagues/${league.toLowerCase()}/events?type=sport&limit=4&offset=${offset}`));
    if(!Array.isArray(page.events))throw new Error('US event response shape is unavailable.');
    for(const event of page.events as Raw[]){if(event.closed||event.ended||!event.active)continue;
      for(const raw of (event.markets??[]) as Raw[]){if(!raw.slug||raw.hidden||!raw.active||raw.closed||!raw.sportsMarketType?.endsWith('full_game_winner'))continue;
        const yes=raw.marketSides?.find((s:Raw)=>s.long===true),no=raw.marketSides?.find((s:Raw)=>s.long===false);
        const bid=number(raw.bestBidQuote?.value),ask=number(raw.bestAskQuote?.value);
        markets.push({slug:raw.slug,id:String(raw.id),league,gameId:String(event.id),game:event.title??event.slug,start:event.startTime??event.eventDate??'',title:`${yes?.description??raw.title} win`,oppositeTitle:no?.description?`${no.description} win`:undefined,question:raw.question??'',rules:raw.description??'',kind:raw.sportsMarketType,teams:(event.teams??[]).map((t:Raw)=>({id:t.id,name:t.name,abbreviation:t.displayAbbreviation??t.abbreviation})),bid,ask,price:ask,volume:number(raw.volume),fee:number(raw.feeCoefficient)??.0695,active:true,history:[],signals:[],observedAt:Date.now()});
      }
    }
    if(page.events.length<4)break;
  }
  return [...new Map(markets.map(m=>[m.slug,m])).values()];
}
async function sports(market:Market):Promise<SportsContext>{
  return cached(`context:${market.gameId}`,60000,async()=>{
    const espn='https://site.api.espn.com/apis/site/v2/sports';
    const unknown:SportsContext={slug:market.slug,league:market.league,status:'unavailable',receivedAt:Date.now(),source:{name:market.league==='MLB'?'MLB Stats API':'ESPN public game data',url:market.league==='MLB'?'https://statsapi.mlb.com':espn,support:market.league==='MLB'?'official':'public-undocumented'},game:null,players:[],changes:[],limitations:[],injuryStatus:'not_verified'};
    try{
      const schedules:ScheduleGame[]=[];
      for(const day of dateKeys(market.start))schedules.push(...await cached(`schedule:${market.league}:${day}`,60000,async()=>market.league==='MLB'?mlbSchedule(await json(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${day}&hydrate=probablePitcher,team`)):nflSchedule(await json(`${espn}/football/nfl/scoreboard?dates=${day.replaceAll('-','')}`))));
      const match=matchingGame(market,[...new Map(schedules.map(g=>[g.id,g])).values()]);
      if(!match.game)return {...unknown,status:'unmatched',limitations:[match.reason]};
      const game=match.game;
      let context:SportsContext;
      if(market.league==='MLB')context=mlbContext(await json(game.sourceUrl),market,game,Date.now());
      else{const [summary,plays]=await Promise.all([json(game.sourceUrl),json(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${game.id}/competitions/${game.id}/plays?limit=500`).catch(()=>null)]);context=nflContext(summary,plays,market,game,Date.now());}
      try{const url=`${espn}/${market.league==='MLB'?'baseball/mlb':'football/nfl'}/injuries`;
        const injuries=await cached(`injuries:${market.league}`,120000,async()=>({data:await json(url),receivedAt:Date.now()}));
        if(!Array.isArray(injuries.data.injuries))throw new Error('Injury response shape unavailable.');
        context.injuries=reportedInjuries(injuries.data,context,url);context.injuryStatus='source_reports';context.injuryReceivedAt=injuries.receivedAt;
      }catch{context.injuryStatus='not_verified';}
      return context;
    }catch(e){return {...unknown,limitations:[e instanceof Error?e.message:'Sports source failed.']};}
  });
}
export async function collectInput(market:Market,held=false):Promise<BotInput>{
  // Resolve slower context/metadata before obtaining the executable book.
  const [context,rawMeta]=await Promise.all([held?Promise.resolve({slug:market.slug,league:market.league,status:'unavailable',receivedAt:Date.now(),source:{name:'Exit check',url:'https://docs.polymarket.us',support:'official'},game:null,players:[],changes:[],injuryStatus:'not_verified',limitations:[]} as SportsContext):sports(market),cached(`meta:${market.slug}`,300000,()=>sourceBudget.run(()=>sdk.markets.retrieveBySlug(market.slug)))]);
  const meta=(rawMeta as Raw).market??rawMeta as Raw;
  const raw=await sourceBudget.run(()=>sdk.markets.book(market.slug)) as unknown as Raw;const receivedAt=Date.now(),data=raw.marketData;
  if(!data||!Array.isArray(data.bids)||!Array.isArray(data.offers))throw new Error('US book response shape is unavailable.');
  const levels=(items:Raw[])=>items.map(l=>({price:number(l.px?.value),quantity:number(l.qty)})).filter(l=>l.price!==null&&l.quantity!==null&&l.quantity>0) as Book['bids'];
  const book:Book={bids:levels(data.bids).sort((a,b)=>b.price-a.price),asks:levels(data.offers).sort((a,b)=>a.price-b.price),time:data.transactTime,state:data.state};
  const minimum=number(meta.minimumTradeQty),tick=number(meta.orderPriceMinTickSize),fee=number(meta.feeCoefficient);
  if(minimum===null||minimum<=0||tick===null||tick<=0||tick>=1||fee===null||fee<0)throw new Error('Verified quantity, tick or fee metadata is missing.');
  const current={...market,fee,active:data.state==='MARKET_STATE_OPEN',bid:book.bids[0]?.price??null,ask:book.asks[0]?.price??null,observedAt:receivedAt};
  const settled=!current.active?await sourceBudget.run(()=>sdk.markets.settlement(market.slug)).then(r=>number((r as Raw).settlement)).catch(()=>null):null;
  const matched={...context,slug:market.slug};
  return {market:current,book,receivedAt,source:'REST',context:matched,settlement:settled,forecast:held?undefined:forecastInput(model,market,matched,meta,receivedAt),executionMarket:{slug:market.slug,league:market.league,active:current.active,minimumTradeQty:minimum,quantityIncrement:minimum,priceIncrement:tick,feeCoefficient:fee}};
}
