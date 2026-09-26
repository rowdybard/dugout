import {readCached,sameOrigin} from '@/lib/server/storage';
import {abortable,sourceError} from '@/lib/server/request-budget';
import {readTennisSession} from '@/lib/tennis/server';
import {loadTennisInput} from '@/lib/tennis/data';
import {watchedBookIssue} from '@/lib/tennis/chart-data';
import type {TennisMarket} from '@/lib/tennis/types';

const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});

/** A selected game's current book. This never ticks the engine or changes paper positions. */
export async function GET(req:Request){
  const controller=new AbortController(),signal=AbortSignal.any([req.signal,controller.signal]);
  const timer=setTimeout(()=>controller.abort(new DOMException('Selected game request timed out.','TimeoutError')),6500);
  try{return await abortable(load(req,signal),signal);}
  catch(error){return reply({error:sourceError(error,'The selected game data is unavailable. Checking again shortly.')},503);}
  finally{clearTimeout(timer);controller.abort(new DOMException('Selected game request finished.','AbortError'));}
}

async function load(req:Request,signal:AbortSignal){
  signal.throwIfAborted();
  try{
    sameOrigin(req);
    const owner=req.headers.get('oai-authenticated-user-id');
    if(!owner||!/^[a-zA-Z0-9_-]{8,160}$/.test(owner))return reply({error:'Sign in to your private Dugout account.'},401);
    const slug=new URL(req.url).searchParams.get('slug');
    if(!slug||!/^[-a-zA-Z0-9]{1,200}$/.test(slug))return reply({error:'Choose a verified game market.'},400);
    const {session,ownerId}=await abortable(readTennisSession(req),signal);
    signal.throwIfAborted();
    if(ownerId!==owner)return reply({error:'The selected paper account could not be verified.'},403);
    // Discovery has already verified this mapping. Never put full schedule pagination on a quote request.
    const cached=await abortable(readCached<TennisMarket>(`tennis:verified:${slug}`),signal);
    signal.throwIfAborted();
    const held=session.positions.find(p=>p.status==='open'&&p.slug===slug);
    const pending=session.pending?.slug===slug?session.pending.market:undefined;
    const market=cached?.value??held?.lastContext??held?.market??pending;
    if(!market||market.slug!==slug||!['ATP','WTA','NFL','CFB'].includes(market.league)||(!session.config.leagues.includes(market.league)&&!held&&!pending))return reply({error:'This game is not in the verified catalog. Refresh the game list.'},404);
    const input=await loadTennisInput({...market,history:[]},AbortSignal.any([signal,AbortSignal.timeout(4500)]),{allowRest:true,lastContext:held?.lastContext});
    signal.throwIfAborted();
    const checkedAt=Date.now(),issue=watchedBookIssue(input,session,checkedAt);
    if(issue)return reply({error:issue},503);
    return reply({input:{...input,market:{...input.market,history:[]}},checkedAt});
  }catch(error){return reply({error:sourceError(error,'The selected game book is unavailable. Checking again shortly.')},503);}
}
