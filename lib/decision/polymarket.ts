import type {Phase,Sport} from './evidence.ts';

/** Minimal read-only Polymarket US gateway access for research scripts (no auth, no orders). */
export const GATEWAY='https://gateway.polymarket.us';

export type SideQuote={name:string;ask:number|null;bid:number|null};
export type GameMarket={
  slug:string;sport:Sport|null;title:string;startTime:number|null;feeCoefficient:number|null;
  closed:boolean;resolved:boolean;
  /** Settlement price of the YES (long) side: 1, 0 or 0.5 for a tie; null until resolved. */
  yesSettle:number|null;
  yes:{name:string};no:{name:string};
};

const SPORTS:Record<string,Sport>={nfl:'NFL',cfb:'CFB',mlb:'MLB',atp:'ATP',wta:'WTA'};
const num=(value:unknown)=>{const parsed=typeof value==='number'?value:typeof value==='string'?Number(value):NaN;return Number.isFinite(parsed)?parsed:null;};
const time=(value:unknown)=>{const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:null;};

/** `aec-cfb-clmsn-cah-2026-09-25` -> CFB. Only full-game `aec-` winner markets are recognised. */
export function sportOfSlug(slug:string):Sport|null {
  const match=/^aec-([a-z]+)-/.exec(slug);
  return match?SPORTS[match[1]]??null:null;
}

export function phaseAt(market:Pick<GameMarket,'startTime'>,now:number):Phase|null {
  return market.startTime===null?null:now<market.startTime?'pregame':'live';
}

type RawSide={long?:boolean;description?:string;price?:string|number};
type RawMarket={slug?:string;question?:string;gameStartTime?:string;feeCoefficient?:number;closed?:boolean;status?:string;marketSides?:RawSide[]};

export function parseMarket(raw:unknown):GameMarket|null {
  const market=(raw as {market?:RawMarket})?.market??raw as RawMarket;
  if(!market||typeof market.slug!=='string')return null;
  const sides=Array.isArray(market.marketSides)?market.marketSides:[];
  const long=sides.find(side=>side.long===true),short=sides.find(side=>side.long===false);
  if(!long||!short)return null;
  const resolved=market.status==='MARKET_STATUS_RESOLVED';
  const settle=resolved?num(long.price):null;
  return {slug:market.slug,sport:sportOfSlug(market.slug),title:market.question??market.slug,startTime:time(market.gameStartTime),
    feeCoefficient:num(market.feeCoefficient),closed:market.closed===true,resolved,
    yesSettle:settle!==null&&[0,0.5,1].includes(settle)?settle:null,
    yes:{name:long.description??'YES'},no:{name:short.description??'NO'}};
}

type RawLevel={px?:{value?:string|number};qty?:string|number};
/** The book lists YES (long) bids and offers. NO prices are complements: NO ask = 1 - YES bid. */
export function parseBook(raw:unknown):{yes:{ask:number|null;bid:number|null};no:{ask:number|null;bid:number|null};open:boolean}|null {
  const data=(raw as {marketData?:{bids?:RawLevel[];offers?:RawLevel[];state?:string}})?.marketData;
  if(!data)return null;
  const prices=(levels:RawLevel[]|undefined)=>(Array.isArray(levels)?levels:[])
    .filter(level=>(num(level.qty)??0)>0).map(level=>num(level.px?.value)).filter((price):price is number=>price!==null&&price>0&&price<1);
  const bids=prices(data.bids),offers=prices(data.offers);
  const bid=bids.length?Math.max(...bids):null,ask=offers.length?Math.min(...offers):null;
  const round=(x:number)=>Math.round(x*1e6)/1e6;
  return {yes:{ask,bid},no:{ask:bid===null?null:round(1-bid),bid:ask===null?null:round(1-ask)},open:data.state==='MARKET_STATE_OPEN'};
}

export type Fetcher=(url:string)=>Promise<unknown>;
export const fetchJson:Fetcher=async url=>{
  const response=await fetch(url,{signal:AbortSignal.timeout(15_000),headers:{accept:'application/json'}});
  if(!response.ok)throw new Error(`Polymarket US returned ${response.status} for ${url}`);
  return response.json();
};

export async function loadMarket(slug:string,get:Fetcher=fetchJson){return parseMarket(await get(`${GATEWAY}/v1/market/slug/${encodeURIComponent(slug)}`));}
export async function loadBook(slug:string,get:Fetcher=fetchJson){return parseBook(await get(`${GATEWAY}/v1/markets/${encodeURIComponent(slug)}/book`));}

/** Open full-game winner markets for one league, in start-time order, up to `until` (epoch ms). */
export async function listOpenGames(league:'cfb'|'nfl'|'mlb',until:number,get:Fetcher=fetchJson,maxPages=20):Promise<GameMarket[]> {
  const type=league==='mlb'?'baseball_team_full_game_winner':'football_team_full_game_winner';
  const games:GameMarket[]=[];
  for(let page=0;page<maxPages;page++){
    const url=`${GATEWAY}/v1/events?closed=false&limit=100&offset=${page*100}&orderBy=startTime&orderDirection=asc&sportsMarketTypes=${type}`;
    const events=((await get(url)) as {events?:{seriesSlug?:string;startTime?:string;markets?:unknown[]}[]}).events??[];
    if(!events.length)break;
    for(const event of events){
      if(!(event.seriesSlug??'').startsWith(`${league}-`))continue;
      for(const raw of event.markets??[]){
        const market=parseMarket(raw);
        if(market?.slug.startsWith(`aec-${league}-`))games.push(market);
      }
    }
    const last=time(events.at(-1)?.startTime);
    if(last!==null&&last>until)break;
  }
  return games.filter(game=>game.startTime!==null&&game.startTime<=until);
}
