import {z} from 'zod';
import {sameOrigin,db} from '@/lib/server/storage';
import {readTennisSession,updateTennisSession,tennisRuntime} from '@/lib/tennis/server';
import {exportTennisJournal} from '@/lib/tennis/journal-export';
import type {TennisAction} from '@/lib/tennis/types';

import {tennisRulesPatchSchema} from '@/lib/tennis/rules';
const internalId=z.string().min(1).max(250).regex(/^[a-zA-Z0-9:_.-]+$/);
const runForMs=z.number().int().min(60_000).max(21_600_000).optional();
const schema=z.union([
  z.object({action:z.literal('start'),config:tennisRulesPatchSchema.optional(),runForMs,commandId:z.string().uuid()}).strict(),
  z.object({action:z.enum(['tick','pause','resume','stop']),runForMs,commandId:z.string().uuid().optional(),sessionId:internalId.optional()}).strict(),
  z.object({action:z.literal('reset'),bankroll:z.number().finite().min(5).max(1000),commandId:z.string().uuid()}).strict(),
  z.object({action:z.literal('update-rules'),rules:tennisRulesPatchSchema,expectedRulesRevision:z.number().int().min(0),sessionId:internalId,commandId:z.string().uuid()}).strict(),
]);
export async function GET(req:Request){
  try{
    const {ownerId,session}=await readTennisSession(req);
    if(new URL(req.url).searchParams.get('export')==='1'){
      return await exportTennisJournal(db(),ownerId);
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
