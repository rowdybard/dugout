import {createTennisSession} from '../../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../../lib/tennis/rules.ts';
import {tennisScoreEvent,tennisScoreMarket} from './tennis-scoreboard-fixture.ts';
import {DatabaseSync} from 'node:sqlite';
import type {TennisSession} from '../../lib/tennis/types';
export {abortable,sourceError} from '../../lib/server/request-budget.ts';
export const env={};
export const SCORE_OWNER='scoreboard-owner-0001';
export const state={account:null as unknown as TennisSession,accountExists:true,runnerOwner:null as string|null,event:null as unknown,sessionGate:null as Promise<void>|null,cacheGate:null as Promise<void>|null,sourceGate:null as Promise<void>|null,sourceError:null as Error|null,sourceSignal:null as AbortSignal|null,sourceIds:[] as string[],sql:[] as string[],writes:[] as string[],cache:new Map<string,{value:unknown;updated:number}>()};
export function resetScoreRoute(){
  const now=Date.now(),market=tennisScoreMarket(now);
  state.account={...createTennisSession({...defaultLiveTennisConfig(100),leagues:['CFB']},now),revision:3};state.accountExists=true;state.runnerOwner=null;
  state.event=tennisScoreEvent(now-1000);state.sessionGate=null;state.cacheGate=null;state.sourceGate=null;state.sourceError=null;state.sourceSignal=null;state.sourceIds=[];state.sql=[];state.writes=[];state.cache.clear();state.cache.set(`tennis:verified:${market.slug}`,{value:market,updated:market.observedAt});
  return market;
}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new Error('Origin mismatch');}
export async function readRunnerOwnedSession(){if(state.sessionGate)await state.sessionGate;return state.runnerOwner?{ownerId:state.runnerOwner,session:state.account}:null;}
export async function readCached<T>(key:string):Promise<{value:T;updated:number}|null>{if(state.cacheGate)await state.cacheGate;return state.cache.get(key) as {value:T;updated:number}|undefined??null;}
export async function publicTennisEvent(eventId:string,signal:AbortSignal){state.sourceIds.push(eventId);state.sourceSignal=signal;if(state.sourceGate)await state.sourceGate;if(state.sourceError)throw state.sourceError;return {data:{events:[state.event]},receipt:{receivedAt:Date.now()}};}
export function db(){return {prepare(sql:string){state.sql.push(sql);
  if(sql==='SELECT value,revision FROM tennis_sessions WHERE owner_id=?')return {bind(owner:string){if(owner!==SCORE_OWNER)throw new Error('Unexpected account owner');return {async first(){return state.accountExists?{value:JSON.stringify(state.account),revision:state.account.revision}:null;}};}};
  if(!sql.startsWith('INSERT INTO cache'))throw new Error('Scoreboard attempted a mutation outside the public cache');
  return {bind(key:string,value:string,updated:number){return {async run(){
    if(!key.startsWith('tennis:scoreboard:v1:'))throw new Error('Unexpected scoreboard cache key');state.writes.push(key);
    const memory=new DatabaseSync(':memory:');try{
      memory.exec('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT,updated INTEGER)');const old=state.cache.get(key);
      if(old)memory.prepare('INSERT INTO cache VALUES(?,?,?)').run(key,JSON.stringify(old.value),old.updated);
      const written=memory.prepare(sql).run(key,value,updated),winner=memory.prepare('SELECT value,updated FROM cache WHERE key=?').get(key) as {value:string;updated:number};
      state.cache.set(key,{value:JSON.parse(winner.value),updated:winner.updated});return {success:true,meta:{changes:Number(written.changes)}};
    }finally{memory.close();}
  }};}};
}};}
