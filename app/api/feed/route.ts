import {getFeed} from '@/lib/server/ingestion';
export async function GET(){try{return Response.json(await getFeed());}catch(e){return Response.json({error:e instanceof Error?e.message:'Feed unavailable'},{status:503});}}
