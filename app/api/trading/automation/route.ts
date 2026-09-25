import { z } from 'zod';
import { profile, saveProfile, sameOrigin, db } from '@/lib/server/storage';
import { ensureTrading, loadExecutionContext, recordTradingObservation, accountFor, policyFor, calculateOrder, commitOrder } from '@/lib/server/trading';
import { DEFAULT_DIP_CONFIG, initialDipState, evaluateDipReversion, recordStrategyExecution } from '@/lib/trading/strategy';

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action:z.literal('start'), slug:z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(250), side:z.enum(['YES','NO']),
    entryBudget:z.number().finite().min(1).max(25), budgetLimit:z.number().finite().min(1).max(100),
    declinePoints:z.number().finite().min(1).max(30), recoveryPoints:z.number().finite().min(.5).max(10),
    targetReturn:z.number().finite().min(.03).max(1), stopReturn:z.number().finite().min(.03).max(.5),
  }).strict(),
  z.object({action:z.literal('pause')}).strict(),
  z.object({action:z.literal('step')}).strict(),
]);
export async function GET(req: Request) {
  try {const p=await profile(req);return Response.json({automation:p.data.trading?.automation??null,defaults:DEFAULT_DIP_CONFIG},{headers:{'Cache-Control':'no-store'}});}
  catch(e){return Response.json({error:e instanceof Error?e.message:'Paper test unavailable.'},{status:503});}
}
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const body=requestSchema.parse(await req.json());
    const p=await profile(req), trading=ensureTrading(p.data);
    if(body.action==='pause') {
      if(trading.automation){trading.automation.status='paused';trading.automation.state.phase='PAUSED';trading.automation.lastReason='Paused. Any open paper position remains available for manual exit.';}
      await saveProfile(p); return Response.json({profile:p.data,automation:trading.automation??null});
    }
    if(body.action==='start') {
      if(body.recoveryPoints>=body.declinePoints) throw new Error('Recovery must be smaller than the qualifying dip.');
      if(body.entryBudget>body.budgetLimit || body.entryBudget>p.data.cash) throw new Error('Entry amount must fit the test budget and available paper cash.');
      if(trading.automation?.positionId && p.data.positions.some(x=>x.id===trading.automation!.positionId&&x.status==='open')) throw new Error('Close the existing strategy position before starting another test.');
      const context=await loadExecutionContext(body.slug,p.data);
      if(context.replay) throw new Error('Paper automation needs current quotes. This development preview uses a labeled recorded capture.');
      if(!context.executionMarket.active) throw new Error('This market is not open.');
      if(!context.market.start || Date.parse(context.market.start)<=Date.now()) throw new Error('This initial paper strategy supports pregame markets only.');
      const config={...DEFAULT_DIP_CONFIG,version:`dip-paper-${crypto.randomUUID()}`,entryBudget:body.entryBudget,
        declinePoints:body.declinePoints,recoveryPoints:body.recoveryPoints,targetReturn:body.targetReturn,stopReturn:body.stopReturn};
      trading.automation={id:crypto.randomUUID(),mode:'paper',status:'running',slug:body.slug,side:body.side,config,
        state:initialDipState(config),startedAt:Date.now(),lastStepAt:0,lastReason:'Collecting current book observations.',
        manualTakeover:false,observations:0,orders:0,budgetLimit:body.budgetLimit,spent:0};
      await saveProfile(p);return Response.json({profile:p.data,automation:trading.automation});
    }
    const session=trading.automation;
    if(!session || session.status!=='running') return Response.json({profile:p.data,automation:session??null});
    if(Date.now()-session.lastStepAt<4500) return Response.json({profile:p.data,automation:session});
    if(session.lastStepAt && Date.now()-session.lastStepAt>30000) {
      session.status='paused';session.state.phase='PAUSED';session.lastReason='Workspace was interrupted. Restart the paper test after reviewing any open position.';
      await saveProfile(p);return Response.json({profile:p.data,automation:session});
    }
    const context=await loadExecutionContext(session.slug,p.data);
    const observed=await recordTradingObservation(session.slug,context.depth,context.replay?'REPLAY':'REST',context.receivedAt);
    const rows=await db().prepare("SELECT time,price FROM trading_observations WHERE slug=? AND time>=? AND price IS NOT NULL AND source!='REPLAY' ORDER BY time")
      .bind(session.slug,Date.now()-session.config.baselineWindowMs).all<{time:number;price:number}>();
    const history=rows.results;
    if(observed.price!==null && !history.some(x=>x.time===observed.time))history.push({time:observed.time,price:observed.price});
    const position=p.data.positions.find(x=>x.id===session.positionId&&x.status==='open');
    const now=Date.now();
    const gamePhase=!context.market.start?'UNKNOWN':Date.parse(context.market.start)>now?'PREGAME':'IN_PLAY';
    const evaluation=evaluateDipReversion(session.config,session.state,{now,market:context.executionMarket,side:session.side,
      book:context.depth,policy:{...policyFor(p.data,context,true),now},account:accountFor(p.data,session.slug,position?.id),gamePhase,history,
      position:position?{quantity:position.contracts,costBasis:position.amount,openedAt:position.time}:undefined});
    session.state=evaluation.state;session.lastStepAt=now;session.lastReason=evaluation.decision.reason;session.observations++;
    if(evaluation.decision.action==='PAUSE'){session.status='paused';await saveProfile(p);return Response.json({profile:p.data,automation:session});}
    if(evaluation.decision.action==='WAIT'){await saveProfile(p);return Response.json({profile:p.data,automation:session});}
    const isBuy=evaluation.decision.action==='BUY';
    if(isBuy && session.spent+session.config.entryBudget>session.budgetLimit){
      session.status='paused';session.state.phase='PAUSED';session.lastReason='Paper test spending limit reached.';await saveProfile(p);
      return Response.json({profile:p.data,automation:session});
    }
    const orderBody={commandId:crypto.randomUUID(),action:evaluation.decision.action as 'BUY'|'SELL',slug:session.slug,side:session.side,
      amount:isBuy?evaluation.decision.budget:undefined,positionId:isBuy?undefined:position?.id,
      percent:isBuy?undefined:100,limitPrice:evaluation.decision.limitPrice!,mode:'paper' as const};
    const order=calculateOrder(p.data,orderBody,context,true);
    if(isBuy&&order.filledQuantity>0){session.positionId=order.positionId;session.spent=Math.round((session.spent-order.cashDelta)*1e6)/1e6;}
    const remaining=p.data.positions.find(x=>x.id===session.positionId&&x.status==='open')?.contracts??0;
    session.state=recordStrategyExecution(session.config,session.state,order.execution,remaining);
    session.orders++;session.lastReason=`${evaluation.decision.reason} ${order.reason}`;
    await commitOrder(p,orderBody,order);
    return Response.json({profile:(await profile(req)).data,automation:session,order});
  } catch(e){return Response.json({error:e instanceof Error?e.message:'Paper test could not update.'},{status:400});}
}
