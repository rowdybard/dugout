import { env } from 'cloudflare:workers';
import { profile, sameOrigin } from '@/lib/server/storage';
import { streamOwnerIssue, type SiteOwnerBindings } from '@/lib/server/owner-access';
import { getCatalog } from '@/lib/server/ingestion';
import { marketStream } from '@/lib/server/polymarket-market-stream';
import { botUniverse } from '@/lib/bot/engine';
import { replayData } from '@/lib/server/replay';
import type {StreamSelection} from '@/lib/trading/stream-types';
export async function GET(req:Request) {
  try {
    sameOrigin(req);
    const denied=streamOwnerIssue(req,env as unknown as SiteOwnerBindings);
    if(denied)return denied;
    if(await replayData())return Response.json({error:'Recorded development preview; no live stream.'},{status:409});
    const params=new URL(req.url).searchParams,slug=params.get('slug'),bot=params.get('scope')==='bot';
    if(!bot&&(!slug||!/^[a-zA-Z0-9_.-]+$/.test(slug)))return Response.json({error:'Choose an MLB or NFL market.'},{status:400});
    const p=await profile(req),session=p.data.trading?.autopilot;
    if(bot&&(!session||session.status==='stopped'))return Response.json({error:'Start a paper session first.'},{status:409});
    const held=bot?session!.positions.filter(p=>p.status==='open'):[];
    let selections:StreamSelection[];
    if(held.length)selections=held.map(p=>({slug:p.slug,league:p.league,detail:'book'}));
    else{
      const catalog=await getCatalog(bot?session!.config.leagues:undefined);
      const selected=bot?botUniverse(catalog.markets,session!,Date.now()).slice(0,16):catalog.games.flatMap(g=>g.markets).filter(m=>m.slug===slug);
      selections=selected.map(m=>({slug:m.slug,league:m.league,detail:'book'}));
    }
    return await marketStream(req,selections);
  }catch{return Response.json({error:'Streaming connection interrupted.'},{status:503});}
}
