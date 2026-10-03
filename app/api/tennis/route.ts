import {getTennisCatalog,getTennisMarket} from '@/lib/tennis/data';
import {readTennisSession} from '@/lib/tennis/server';
import {db} from '@/lib/server/storage';
import {readChartRejections} from '@/lib/tennis/chart-rejections';
import {boundedCatalogOperation} from '@/lib/tennis/catalog-loader';
import {accountBotView} from '@/lib/tennis/account';
import {requestedBot} from '@/lib/tennis/bot-request';
export async function GET(req:Request){
  try{
    return await boundedCatalogOperation(async()=>{
    const slug=new URL(req.url).searchParams.get('slug');
    if(slug&&(!/^[a-zA-Z0-9_.-]+$/.test(slug)||slug.length>250))return Response.json({error:'Choose a valid game market.'},{status:400});
    const {session:account,ownerId}=await readTennisSession(req),session=accountBotView(account,requestedBot(req));
    const rejectedBooks=await readChartRejections(db(),ownerId,Date.now());
    const result=slug?{markets:[await getTennisMarket(slug,session.config.leagues,rejectedBooks[slug],true)],updatedAt:Date.now(),errors:[]}:await getTennisCatalog({includeHistory:false,leagues:session.config.leagues,rejectedBooks,signal:req.signal});
    return Response.json({...result,leagues:session.config.leagues},{headers:{'Cache-Control':'no-store'}});
    },Date.now()+10_000,Date.now,req.signal);
  }catch(e){return Response.json({markets:[],updatedAt:Date.now(),errors:[e instanceof Error?e.message:'Game markets are unavailable.']},{status:503});}
}
