import {env} from 'cloudflare:workers';
import {db,readCached,sameOrigin} from '@/lib/server/storage';
import {abortable,sourceError} from '@/lib/server/request-budget';
import {publicTennisEvent} from '@/lib/server/polymarket';
import {readRunnerOwnedSession,type RunnerBindings} from '@/lib/runner/sites-proxy';
import {accountBotView} from '@/lib/tennis/account';
import {requestedBot} from '@/lib/tennis/bot-request';
import {latestVerifiedTennisScoreboard,loadTennisScoreboard,type TennisScoreboardRecord} from '@/lib/tennis/tennis-scoreboard';
import type {TennisMarket,TennisSession} from '@/lib/tennis/types';

const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});

/** Selected tennis scoreboard; public cache writes never initialize or modify a paper account. */
export async function GET(req:Request){
  const controller=new AbortController(),signal=AbortSignal.any([req.signal,controller.signal]);
  const timer=setTimeout(()=>controller.abort(new DOMException('Selected tennis scoreboard request timed out.','TimeoutError')),6500);
  try{return await abortable(load(req,signal),signal);}
  catch(error){return reply({error:sourceError(error,'The tennis scoreboard is unavailable. Checking again shortly.')},503);}
  finally{clearTimeout(timer);controller.abort(new DOMException('Selected tennis scoreboard request finished.','AbortError'));}
}

async function load(req:Request,signal:AbortSignal){
  signal.throwIfAborted();
  try{sameOrigin(req);}catch{return reply({error:'Request origin mismatch.'},403);}
  const owner=req.headers.get('oai-authenticated-user-id');
  if(!owner||!/^[a-zA-Z0-9_-]{8,160}$/.test(owner))return reply({error:'Sign in to your private Dugout account.'},401);
  const slug=new URL(req.url).searchParams.get('slug');
  if(!slug||!/^[-a-zA-Z0-9]{1,200}$/.test(slug))return reply({error:'Choose a verified tennis market.'},400);
  let botId;try{botId=requestedBot(req);}catch{return reply({error:'Choose the Football or Tennis bot.'},400);}
  const database=db();
  const runner=await abortable(readRunnerOwnedSession(req,database,env as RunnerBindings),signal);signal.throwIfAborted();
  let account:TennisSession;
  if(runner){
    if(runner.ownerId!==owner)return reply({error:'The selected paper account could not be verified.'},403);
    account=runner.session;
  }else{
    const row=await abortable(database.prepare('SELECT value,revision FROM tennis_sessions WHERE owner_id=?').bind(owner).first<{value:string;revision:number}>(),signal);signal.throwIfAborted();
    if(!row)return reply({error:'Open your paper account before selecting a tennis match.'},404);
    account={...JSON.parse(row.value) as TennisSession,revision:row.revision};
  }
  const session=accountBotView(account,botId);
  const cached=await abortable(readCached<TennisMarket>(`tennis:verified:${slug}`).catch(()=>null),signal);signal.throwIfAborted();
  const held=session.positions.find(position=>position.status==='open'&&position.slug===slug);
  const pending=session.pending?.slug===slug?session.pending.market:undefined;
  const market=latestVerifiedTennisScoreboard([cached?.value,held?.lastContext,held?.market,pending].filter(value=>value?.slug===slug));
  if(!market||market.slug!==slug||!['ATP','WTA'].includes(market.league)||!session.config.leagues.includes(market.league)&&!held&&!pending)
    return reply({error:'This tennis match is not in the verified catalog. Refresh the game list.'},404);
  const result=await loadTennisScoreboard({...market,history:[]},{
    now:Date.now,
    read:async key=>(await readCached<TennisScoreboardRecord>(key))?.value??null,
    write:async(key,record)=>{
      signal.throwIfAborted();
      const written=await database.prepare(`INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated
        WHERE COALESCE(json_extract(excluded.value,'$.market.contextUpdatedAt'),-1)>COALESCE(json_extract(cache.value,'$.market.contextUpdatedAt'),-1)
        OR COALESCE(json_extract(excluded.value,'$.market.contextUpdatedAt'),-1)=COALESCE(json_extract(cache.value,'$.market.contextUpdatedAt'),-1)
          AND json_extract(excluded.value,'$.market.score') IS json_extract(cache.value,'$.market.score')
          AND json_extract(excluded.value,'$.market.period') IS json_extract(cache.value,'$.market.period')
          AND json_extract(excluded.value,'$.market.live') IS json_extract(cache.value,'$.market.live')
          AND json_extract(excluded.value,'$.market.ended') IS json_extract(cache.value,'$.market.ended')
          AND (json_extract(cache.value,'$.market.tennis') IS NULL OR json_extract(excluded.value,'$.market.tennis') IS json_extract(cache.value,'$.market.tennis'))
          AND (json_extract(cache.value,'$.market.tennisIdentity') IS NULL OR json_extract(excluded.value,'$.market.tennisIdentity') IS json_extract(cache.value,'$.market.tennisIdentity'))
          AND (json_extract(excluded.value,'$.market.observedAt')>json_extract(cache.value,'$.market.observedAt')
            OR json_extract(excluded.value,'$.market.observedAt')=json_extract(cache.value,'$.market.observedAt') AND excluded.updated>=cache.updated)`)
        .bind(key,JSON.stringify(record),record.fetchedAt).run();
      return written.meta.changes>0;
    },
    fetchEvent:publicTennisEvent,
  },signal);
  signal.throwIfAborted();
  return reply({market:{...result.market,history:[]},successfulCheckAt:result.successfulCheckAt,error:result.error,cacheHit:result.cacheHit,checkedAt:Date.now()});
}
