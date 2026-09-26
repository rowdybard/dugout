import {getTennisCatalog,getTennisMarket} from '@/lib/tennis/data';
import {readTennisSession} from '@/lib/tennis/server';
import {db} from '@/lib/server/storage';
import {readChartRejections} from '@/lib/tennis/chart-rejections';
export async function GET(req:Request){
  try{
    const slug=new URL(req.url).searchParams.get('slug');
    if(slug&&(!/^[a-zA-Z0-9_.-]+$/.test(slug)||slug.length>250))return Response.json({error:'Choose a valid game market.'},{status:400});
    const {session,ownerId}=await readTennisSession(req);
    const rejectedBooks=await readChartRejections(db(),ownerId,Date.now());
    const result=slug?{markets:[await getTennisMarket(slug,session.config.leagues,rejectedBooks[slug],true)],updatedAt:Date.now(),errors:[]}:await getTennisCatalog({includeHistory:false,leagues:session.config.leagues,rejectedBooks});
    return Response.json({...result,leagues:session.config.leagues},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({markets:[],updatedAt:Date.now(),errors:[e instanceof Error?e.message:'Game markets are unavailable.']},{status:503});}
}
