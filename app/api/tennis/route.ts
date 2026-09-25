import {getTennisCatalog,getTennisMarket} from '@/lib/tennis/data';
export async function GET(req:Request){
  try{
    const slug=new URL(req.url).searchParams.get('slug');
    if(slug&&(!/^[a-zA-Z0-9_.-]+$/.test(slug)||slug.length>250))return Response.json({error:'Choose a valid tennis market.'},{status:400});
    const result=slug?{markets:[await getTennisMarket(slug)],updatedAt:Date.now(),errors:[]}:await getTennisCatalog();
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({markets:[],updatedAt:Date.now(),errors:[e instanceof Error?e.message:'Tennis markets are unavailable.']},{status:503});}
}
