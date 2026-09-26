import {getTennisCatalog,getTennisMarket} from '@/lib/tennis/data';
import {readTennisSession} from '@/lib/tennis/server';
export async function GET(req:Request){
  try{
    const slug=new URL(req.url).searchParams.get('slug');
    if(slug&&(!/^[a-zA-Z0-9_.-]+$/.test(slug)||slug.length>250))return Response.json({error:'Choose a valid game market.'},{status:400});
    const {session}=await readTennisSession(req);
    const result=slug?{markets:[await getTennisMarket(slug,session.config.leagues)],updatedAt:Date.now(),errors:[]}:await getTennisCatalog({leagues:session.config.leagues});
    return Response.json({...result,leagues:session.config.leagues},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({markets:[],updatedAt:Date.now(),errors:[e instanceof Error?e.message:'Game markets are unavailable.']},{status:503});}
}
