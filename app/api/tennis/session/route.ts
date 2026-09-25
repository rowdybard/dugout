import {z} from 'zod';
import {sameOrigin,db} from '@/lib/server/storage';
import {readTennisSession,updateTennisSession,tennisRuntime} from '@/lib/tennis/server';
import type {TennisAction} from '@/lib/tennis/types';

const config=z.object({
  startingCash:z.number().finite().min(5).max(1000).optional(),entryBudget:z.number().finite().min(1).max(1000).optional(),
  leagues:z.array(z.enum(['ATP','WTA'])).min(1).max(2).optional(),
  declinePoints:z.number().finite().min(1).max(30).optional(),recoveryPoints:z.number().finite().min(.5).max(15).optional(),
  targetReturn:z.number().finite().min(.005).max(1).optional(),stopReturn:z.number().finite().min(.01).max(.5).optional(),
  maxHoldMs:z.number().finite().int().min(10000).max(3600000).optional(),
  maxSpreadPoints:z.number().finite().min(.1).max(10).optional(),
}).strict();
const internalId=z.string().min(1).max(250).regex(/^[a-zA-Z0-9:_.-]+$/);
const control=z.object({action:z.enum(['tick','pause','resume','stop']),commandId:z.string().uuid().optional(),sessionId:internalId.optional()}).strict();
const schema=z.union([
  z.object({action:z.literal('start'),config:config.optional(),commandId:z.string().uuid()}).strict(),
  control,
  z.object({action:z.literal('reset'),bankroll:z.number().finite().min(5).max(1000),commandId:z.string().uuid()}).strict(),
  z.object({action:z.literal('buy'),slug:z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(250),side:z.enum(['YES','NO']),amount:z.number().finite().min(1).max(1000),commandId:z.string().uuid()}).strict(),
  z.object({action:z.literal('close'),positionId:internalId,commandId:z.string().uuid()}).strict(),
]);
export async function GET(req:Request){
  try{
    const {ownerId,session}=await readTennisSession(req);
    if(new URL(req.url).searchParams.get('export')==='1'){
      const rows=await db().prepare('SELECT kind,value,created_at FROM tennis_journal WHERE owner_id=? AND session_id=? ORDER BY created_at LIMIT 10001').bind(ownerId,session.id).all<{kind:string;value:string;created_at:number}>();
      return Response.json({session,records:rows.results.slice(0,10000).map(r=>({kind:r.kind,value:JSON.parse(r.value),time:r.created_at})),truncated:rows.results.length>10000},{headers:{'Cache-Control':'no-store','Content-Disposition':'attachment; filename="dugout-tennis-paper-session.json"'}});
    }
    return Response.json({session,runtime:tennisRuntime()},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'Paper account unavailable.'},{status:503});}
}
export async function POST(req:Request){
  try{
    sameOrigin(req);const parsed=schema.safeParse(await req.json());
    if(!parsed.success)return Response.json({error:'Check the amount and paper-session settings.'},{status:400});
    const session=await updateTennisSession(req,parsed.data as TennisAction);
    return Response.json({session,runtime:tennisRuntime()},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({error:e instanceof Error?e.message:'Paper action could not complete.'},{status:400});}
}
