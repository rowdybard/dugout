import {db,readCached,sameOrigin} from '@/lib/server/storage';
import {sourceError} from '@/lib/server/request-budget';
import {publicGet} from '@/lib/server/polymarket';
import {readTennisSession} from '@/lib/tennis/server';
import {loadPriorityContext,type PriorityContextRecord} from '@/lib/tennis/priority-context';
import type {TennisMarket} from '@/lib/tennis/types';

const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});

/** Current report for one verified football game. Quotes and paper accounting are untouched. */
export async function GET(req:Request){
  try{sameOrigin(req);}catch{return reply({error:'Request origin mismatch.'},403);}
  const owner=req.headers.get('oai-authenticated-user-id');
  if(!owner||!/^[a-zA-Z0-9_-]{8,160}$/.test(owner))return reply({error:'Sign in to your private Dugout account.'},401);
  const slug=new URL(req.url).searchParams.get('slug');
  if(!slug||!/^[-a-zA-Z0-9]{1,200}$/.test(slug))return reply({error:'Choose a verified game market.'},400);
  try{
    const {session,ownerId}=await readTennisSession(req);
    if(ownerId!==owner)return reply({error:'The selected paper account could not be verified.'},403);
    const cached=await readCached<TennisMarket>(`tennis:verified:${slug}`).catch(()=>null);
    const held=session.positions.find(p=>p.status==='open'&&p.slug===slug);
    const pending=session.pending?.slug===slug?session.pending.market:undefined;
    const market=cached?.value??held?.lastContext??held?.market??pending;
    if(!market||market.slug!==slug||!['NFL','CFB'].includes(market.league)||(!session.config.leagues.includes(market.league)&&!held&&!pending))return reply({error:'This football game is not in the verified catalog. Refresh the game list.'},404);
    const result=await loadPriorityContext({...market,history:[]},{
      now:Date.now,
      read:async key=>(await readCached<PriorityContextRecord>(key))?.value??null,
      write:async(key,record)=>{
        await db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE excluded.updated>=cache.updated')
          .bind(key,JSON.stringify(record),record.fetchedAt).run();
      },
      // The shared source client retains provider backoff and the normal request budget.
      fetchEvent:publicGet,
    },AbortSignal.any([req.signal,AbortSignal.timeout(4500)]));
    // Never expose reportMarket as the display value: a conflicting candidate is engine evidence only.
    return reply({market:{...result.market,history:[]},assessment:result.assessment,error:result.error,cacheHit:result.cacheHit,checkedAt:Date.now()});
  }catch(error){return reply({error:sourceError(error,'The selected game report is unavailable. Checking again shortly.')},503);}
}
