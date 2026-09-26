import {executePaperCommand} from '../trading/execution.ts';
import type {ExecutionPolicy} from '../trading/types.ts';
import type {TennisInput,TennisSession} from './types.ts';
import {isFootballMarket} from './football-context.ts';

const exact=(value:number)=>Math.round(value*1_000_000)/1_000_000;
/** Counterfactual sells have isolated inventory, IDs and proceeds. They never call the account fill reducer. */
export function advanceShadowExits(session:TennisSession,input:TennisInput,now:number,bookUsable:boolean,policy:ExecutionPolicy):void{
  if(session.config.decisionPolicy!=='football-context-v1'||!isFootballMarket(input.market)||input.source==='REPLAY')return;
  const state=session.footballReports?.[input.market.slug];
  const report=state?.assessment.status==='fresh'?state.report:undefined;
  session.shadowExits??={};session.shadowContexts??={};
  for(const position of session.positions.filter(p=>p.slug===input.market.slug)){
    let shadow=session.shadowExits[position.id];
    if(!shadow&&position.status==='open'&&input.market.live&&!input.market.ended&&report&&position.entryContext){
      const heldTeam=position.side==='YES'?report.yesTeamId:report.noTeamId;
      const before=session.shadowContexts[position.id]??position.entryContext;
      const possessionLost=report.reportTime>before.reportTime&&before.possessionTeamId===heldTeam&&report.possessionTeamId!==heldTeam;
      const fourthDown=report.possessionTeamId===heldTeam&&report.down===4;
      session.shadowContexts[position.id]=report;
      if(possessionLost||fourthDown){
        shadow={positionId:position.id,slug:position.slug,side:position.side,reason:possessionLost?'POSSESSION_LOST':'FOURTH_DOWN',
          context:structuredClone(report),startedAt:now,initialQuantity:position.quantity,remainingQuantity:position.quantity,
          costBasis:position.costBasis,proceeds:0,fees:0,status:'pending',fills:[]};
        session.shadowExits[position.id]=shadow;
      }
    }
    if(!shadow||shadow.status==='closed'||shadow.status==='ended')continue;
    if(position.status!=='open'){
      // A later actual exit ends the comparison window. No invented counterfactual fill.
      shadow.status='ended';shadow.pending=undefined;shadow.closedAt=now;continue;
    }
    if(!bookUsable||input.receivedAt<=(shadow.lastBookTime??-1))continue;
    const bestBid=shadow.side==='YES'?input.book.bids[0]?.price:input.book.asks[0]?exact(1-input.book.asks[0].price):undefined;
    const pending=shadow.pending;
    if(pending){
      if(now-pending.createdAt>policy.maxCommandAgeMs){shadow.pending=undefined;}
      else if(now>=pending.executeAfter&&input.receivedAt>=pending.executeAfter&&input.receivedAt>pending.bookTime){
        const result=executePaperCommand({commandId:pending.id,marketSlug:shadow.slug,positionId:shadow.positionId,side:shadow.side,action:'SELL',source:'AUTOMATIC',
          quantity:shadow.remainingQuantity,limitPrice:pending.limitPrice,createdAt:pending.createdAt,strategyVersion:'football-shadow-exit-v1'},
          {cash:0,marketExposure:shadow.costBasis,totalExposure:shadow.costBasis,availableQuantity:shadow.remainingQuantity},input.market.execution!,input.book,policy);
        shadow.fills.push({id:pending.id,time:now,signalBookTime:pending.bookTime,executionBookTime:input.receivedAt,execution:result});
        shadow.pending=undefined;shadow.lastBookTime=input.receivedAt;
        if(result.apply){shadow.remainingQuantity=exact(shadow.remainingQuantity-result.filledQty);shadow.proceeds=exact(shadow.proceeds+result.cashDelta);shadow.fees=exact(shadow.fees+result.fees);}
        if(shadow.remainingQuantity<=0){shadow.status='closed';shadow.closedAt=now;}
        else shadow.status=shadow.remainingQuantity<shadow.initialQuantity?'partial':'pending';
        continue;
      }else continue;
    }
    if(bestBid!==undefined&&bestBid>0&&bestBid<1){
      shadow.pending={id:`shadow:${position.id}:${shadow.fills.length}:${now}`,createdAt:now,executeAfter:now+session.config.executionDelayMs,bookTime:input.receivedAt,limitPrice:bestBid};
      shadow.lastBookTime=input.receivedAt;
    }
  }
}
