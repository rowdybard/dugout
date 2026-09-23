import { profile } from '@/lib/server/storage';
import { getFeed } from '@/lib/server/ingestion';
import { serviceRequest } from '@/lib/server/trading-service';
export async function GET(req:Request) {
  try {
    const slug=new URL(req.url).searchParams.get('slug');
    if(!slug||!/^[a-zA-Z0-9_.-]+$/.test(slug))return Response.json({error:'Choose an MLB or NFL market.'},{status:400});
    const status=await serviceRequest('/v1/status');
    if(!status)return Response.json({error:'Streaming is not connected.'},{status:503});
    if(!status.ok)return Response.json({error:'Streaming service unavailable.'},{status:503});
    const [p,feed]=await Promise.all([profile(req),getFeed()]);
    const market=feed.games.flatMap(g=>g.markets).find(m=>m.slug===slug);
    if(!market)return Response.json({error:'Market is outside MLB/NFL coverage.'},{status:400});
    const subscribe=await serviceRequest('/v1/subscriptions',{method:'POST',body:JSON.stringify({ownerId:`${p.id}:${slug}`,markets:[{slug,league:market.league,detail:'book'}]})});
    if(!subscribe?.ok)return Response.json({error:'Could not subscribe to this market.'},{status:503});
    const upstream=await serviceRequest(`/v1/events?markets=${encodeURIComponent(slug)}&ownerId=${encodeURIComponent(`${p.id}:${slug}`)}`,{signal:req.signal});
    if(!upstream?.ok||!upstream.body)return Response.json({error:'Streaming unavailable.'},{status:503});
    return new Response(upstream.body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'}});
  }catch{return Response.json({error:'Streaming connection interrupted.'},{status:503});}
}
