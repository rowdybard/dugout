import {replayData} from './replay';
import type {Feed,Game,League,Market,Point} from '@/lib/market/types';
import {scan,activitySignals,DEFAULT_CONFIG} from '@/lib/market/scanner';
import {amount,getLeaguePage,history,numeric,bbo,type Raw} from './polymarket';
import {cached,db} from './storage';
function normalize(e:Raw,league:League):Game{
 const teams=(e.teams||[]).map((t:Raw)=>({id:t.id,name:t.name,abbreviation:t.displayAbbreviation||t.abbreviation,record:t.record,logo:t.logo}));
 const game:Game={id:String(e.id),title:e.title||e.slug,league,start:e.startTime||e.eventDate||'',teams,markets:[]};
 game.markets=(e.markets||[]).filter((m:Raw)=>m.slug&&!m.hidden&&m.active&&!m.closed).map((m:Raw):Market=>{
 const long=m.marketSides?.find((s:Raw)=>s.long===true);const winner=m.sportsMarketType?.endsWith('full_game_winner');
 const bid=amount(m.bestBidQuote),ask=amount(m.bestAskQuote);return {slug:m.slug,id:String(m.id),title:winner&&long?.description?`${long.description} win`:m.title||m.question,oppositeTitle:winner?`${m.marketSides?.find((s:Raw)=>s.long===false)?.description||'Other team'} win`:`NO · ${m.title||m.question}`,question:m.question||'',rules:m.description||'',gameId:game.id,game:game.title,league,start:game.start,teams:winner?teams:[],kind:m.sportsMarketType||'',bid,ask,price:ask,volume:numeric(m.volume),fee:numeric(m.feeCoefficient)??.0695,active:true,history:[],signals:[],observedAt:Date.now()};
 });return game;
}
async function mapLimit<T,R>(items:T[],fn:(x:T)=>Promise<R>,n=3){const result:R[]=new Array(items.length);let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const j=i++;result[j]=await fn(items[j]);await new Promise(r=>setTimeout(r,180));}}));return result;}
export async function getFeed():Promise<Feed>{return cached('feed-v5',60000,async()=>{
 const games:Game[]=[];const errors:string[]=[];
 for(const league of ['MLB','NFL'] as League[]){try{for(let offset=0;offset<24;offset+=4){const page=await getLeaguePage(league.toLowerCase(),offset);const events=page.events||[];for(const e of events){if(!e.closed&&!e.ended&&e.active){const g=normalize(e,league);if(g.markets.length)games.push(g);}}if(events.length<4)break;}}catch(e){console.error('league feed',league,e);errors.push(`${league} feed is temporarily unavailable.`);}}
 if(!games.length&&errors.length)throw new Error('Unable to reach Polymarket US right now. Please try again shortly.');
 const unique=[...new Map(games.map(g=>[g.id,g])).values()];
 const markets=unique.map(g=>g.markets.find(m=>m.kind.endsWith('full_game_winner'))||g.markets[0]).filter(Boolean);
 await mapLimit(markets,async m=>{
 try{m.history=await history(m.slug);}catch{m.historyError='History unavailable';}
 try{const q=await bbo(m.slug);m.bid=amount(q.bestBid);m.ask=amount(q.bestAsk);m.price=m.ask;m.volume=numeric(q.sharesTraded);const bids=numeric(q.bidShares),asks=numeric(q.askShares);m.depth=bids!==null&&asks!==null?bids+asks:null;m.active=q.state==='MARKET_STATE_OPEN';m.observedAt=Date.now();}catch{/* Listing quotes retain their observation timestamp. */}
 m.signals=scan(m);await enrich(m);await record(m);return m;
 });
 await db().prepare('DELETE FROM cache WHERE updated < ?').bind(Date.now()-7*86400000).run();
 await db().prepare('DELETE FROM snapshots WHERE time < ?').bind(Date.now()-30*86400000).run();
 return {games:unique,markets,updated:Date.now(),errors,replayAt:(await replayData())?.recordedAt,coverage:'Full-game winner markets · up to 24 games per league. All available markets inside each game.'};
 });}
export async function record(m:Market){await db().prepare('INSERT OR IGNORE INTO snapshots(id,slug,time,price,bid,ask,volume,depth,signals) VALUES(?,?,?,?,?,?,?,?,?)').bind(`${m.slug}:${Math.floor(Date.now()/60000)}`,m.slug,Date.now(),m.price,m.bid,m.ask,m.volume,m.depth??null,JSON.stringify(m.signals)).run();}
export async function enrich(m:Market){const rows=await db().prepare('SELECT time,price,volume FROM snapshots WHERE slug=? AND time>? ORDER BY time').bind(m.slug,Date.now()-3600000).all<Point>();m.signals.push(...activitySignals(rows.results,DEFAULT_CONFIG));return m;}
