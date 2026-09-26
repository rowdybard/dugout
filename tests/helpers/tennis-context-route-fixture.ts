import {normalizeTennisEvent} from '../../lib/tennis/normalize.ts';
import type {TennisMarket,TennisSession} from '../../lib/tennis/types';

export const OWNER='synthetic-owner-0001';
export const state={owner:OWNER,session:null as unknown as TennisSession,event:null as unknown,sessionReads:0,paths:[] as string[],writes:[] as string[],error:null as Error|null,cache:new Map<string,{value:unknown;updated:number}>()};
export function reset(){
  const now=Date.now(),event={id:'game-123',slug:'cfb-navy-uab-2026-09-26',title:'Navy vs UAB',startTime:new Date(now-3600000).toISOString(),active:true,live:true,ended:false,score:'7-0',period:'Q1',eventState:{type:'football',live:true,ended:false,period:'Q1',elapsed:'10:37',updatedAt:new Date(now-1000).toISOString(),footballState:{driveState:{possessionTeamId:'1245',down:2,yfd:12,fieldPosition:{teamId:'1157',yard:12}}}},markets:[{slug:'aec-cfb-navy-uab-2026-09-26',sportsMarketType:'football_team_full_game_winner',active:true,closed:false,status:'MARKET_STATUS_OPEN',minimumTradeQty:.01,orderPriceMinTickSize:.005,feeCoefficient:.0695,bestBidQuote:{value:'.415'},bestAskQuote:{value:'.420'},marketSides:[{long:false,description:'Blazers',teamId:1157,team:{id:1157,name:'UAB',league:'cfb',ordering:'home'}},{long:true,description:'Midshipmen',teamId:1245,team:{id:1245,name:'Navy',league:'cfb',ordering:'away'}}]}]};
  const market=normalizeTennisEvent(event,'CFB',now-500)[0];
  state.owner=OWNER;state.session={id:'synthetic-session',config:{leagues:['CFB']},positions:[],pending:null,cash:100,ledger:[]} as unknown as TennisSession;
  state.event=event;state.sessionReads=0;state.paths=[];state.writes=[];state.error=null;state.cache.clear();state.cache.set(`tennis:verified:${market.slug}`,{value:market,updated:market.observedAt});
  return market;
}
export function sameOrigin(req:Request){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new Error('Wrong origin');}
export async function readTennisSession(){state.sessionReads++;return {ownerId:state.owner,session:state.session};}
export async function readCached<T>(key:string):Promise<{value:T;updated:number}|null>{return state.cache.get(key) as {value:T;updated:number}|undefined??null;}
export async function publicGet(path:string){state.paths.push(path);if(state.error)throw state.error;return {event:state.event};}
export const sourceError=(error:unknown,fallback:string)=>error instanceof Error?error.message:fallback;
export function db(){return {prepare(sql:string){if(!sql.startsWith('INSERT INTO cache'))throw new Error('Unexpected mutation outside the public context cache.');return {bind(key:string,value:string,updated:number){return {async run(){state.writes.push(key);const previous=state.cache.get(key);if(!previous||updated>=previous.updated)state.cache.set(key,{value:JSON.parse(value),updated});return {success:true};}};}};}};}
export function held(market:TennisMarket){state.session.positions=[{id:'held',slug:market.slug,status:'open',market,lastContext:market}] as TennisSession['positions'];}
