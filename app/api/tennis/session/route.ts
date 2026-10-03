import {z} from 'zod';
import {env} from 'cloudflare:workers';
import {proxyRunnerSession,type RunnerBindings} from '@/lib/runner/sites-proxy';
import {runnerError} from '@/lib/runner/protocol';
import {sameOrigin,db,requireUserId} from '@/lib/server/storage';
import {readTennisSession,updateTennisSession,tennisRuntime} from '@/lib/tennis/server';
import {exportTennisJournal} from '@/lib/tennis/journal-export';
import type {TennisAction} from '@/lib/tennis/types';

import {MAX_BALANCE,tennisRulesPatchSchema} from '@/lib/tennis/rules';
const internalId=z.string().min(1).max(250).regex(/^[a-zA-Z0-9:_.-]+$/);
const lossAcknowledgement=z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_.-]+$/).nullable();
const runForMs=z.number().int().min(60_000).max(21_600_000).optional();
const botId=z.enum(['football','tennis']).optional();
const schema=z.union([
  z.object({action:z.literal('start'),botId,config:tennisRulesPatchSchema.optional(),runForMs,commandId:z.string().uuid()}).strict(),
  z.object({action:z.enum(['tick','pause','resume','stop']),botId,runForMs,commandId:z.string().uuid().optional(),sessionId:internalId.optional()}).strict(),
  z.object({action:z.literal('acknowledge-loss'),botId,sessionId:internalId,commandId:z.string().uuid(),expectedLossAcknowledgement:lossAcknowledgement,runForMs}).strict(),
  z.object({action:z.literal('exit-now'),botId,commandId:z.string().uuid()}).strict(),
  z.object({action:z.literal('reset'),botId,bankroll:z.number().finite().min(5).max(MAX_BALANCE),commandId:z.string().uuid(),abandon:z.literal(true).optional()}).strict(),
  z.object({action:z.literal('update-rules'),botId,rules:tennisRulesPatchSchema,expectedRulesRevision:z.number().int().min(0),sessionId:internalId,commandId:z.string().uuid()}).strict(),
]);
export async function GET(req:Request){
  try{
    const runner=await proxyRunnerSession(req,db(),env as RunnerBindings);if(runner)return runner;
    const {ownerId,session}=await readTennisSession(req);
    if(new URL(req.url).searchParams.get('export')==='1'){
      return await exportTennisJournal(db(),ownerId);
    }
    return Response.json({session,runtime:tennisRuntime(ownerId)},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return runnerError(e);}
}
export async function POST(req:Request){
  try{
    sameOrigin(req);const parsed=schema.safeParse(await req.json());
    if(!parsed.success)return Response.json({error:'Check the amount and paper-session settings.'},{status:400});
    const runner=await proxyRunnerSession(req,db(),env as RunnerBindings,parsed.data as TennisAction);if(runner)return runner;
    const session=await updateTennisSession(req,parsed.data as TennisAction);
    return Response.json({session,runtime:tennisRuntime(requireUserId(req))},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return runnerError(e);}
}
