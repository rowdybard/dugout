import {credentialStatus} from '@/lib/server/polymarket-credentials';

export async function GET(){
  try{return Response.json(await credentialStatus(),{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({state:'unavailable',configured:false,checkedAt:Date.now(),liveEnabled:false,message:'Connection status is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
