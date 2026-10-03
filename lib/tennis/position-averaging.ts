import type {PaperExecution} from '../trading/types';
import type {TennisPosition,TennisSession} from './types';
import {walletCommitments,walletProjection} from './wallet-risk.ts';
import {lossLimitReached} from './loss-limit.ts';

const exact=(value:number)=>Math.round(value*1e6)/1e6;
const EPSILON=1e-7;
export type TennisAddState={
  filledBuys:0|1;troughBid:number|null;troughAsk:number|null;troughAt:number|null;
  armedAt:number|null;drop:number|null;recovery:number|null;confirmations:number;lastBookTime:number|null;
};
export type TennisAveragingRules={drop:number;recovery:number;confirmations:number;windowMs:number;maxBookAgeMs:number};
export type TennisAveragingQuote={bid:number;ask:number;bookTime:number};
export const newTennisAddState=():TennisAddState=>({filledBuys:0,troughBid:null,troughAsk:null,troughAt:null,armedAt:null,drop:null,recovery:null,confirmations:0,lastBookTime:null});

/** Whole-position result includes prior realized exits and every entry/exit fee. */
export function tennisPositionNetPnl(position:TennisPosition,netExitValue:number):number{
  return exact(position.realizedPnl+netExitValue-position.costBasis);
}
export function tennisPositionLossReached(position:TennisPosition,netExitValue:number|null=null):boolean{
  const maximum=position.tennisTrend?.maxLossDollars;
  if(typeof maximum!=='number'||!Number.isFinite(maximum)||maximum<=0)return false;
  return position.realizedPnl<=-maximum||netExitValue!==null&&Number.isFinite(netExitValue)&&tennisPositionNetPnl(position,netExitValue)<=-maximum;
}
function positionIssue(position:TennisPosition):string|null{
  const trend=position.tennisTrend;
  if(!trend||trend.version!=='2'||position.status!=='open'||!['ATP','WTA'].includes(position.league))return 'Averaging is available only for an open adaptive Tennis trade.';
  if(!Number.isFinite(trend.initialCost)||trend.initialCost<=0||!Number.isFinite(trend.maxLossDollars)||trend.maxLossDollars<=0||!Number.isFinite(position.quantity)||position.quantity<=0||!Number.isFinite(position.entryPrice)||position.entryPrice<=0||position.entryPrice>=1)
    return 'The original Tennis stake or purchase accounting is unavailable.';
  if((position.tennisAdd?.filledBuys??0)>=1)return 'This trade already used its one additional buy.';
  if(Math.abs(position.quantity-position.initialQuantity)>EPSILON||position.proceeds>EPSILON||Math.abs(position.exitFees)>EPSILON)return 'A sale already started; averaging cannot reopen sold quantity.';
  if(trend.protectedProfit!==null)return 'The profit trail is armed; exits take priority over averaging.';
  if(tennisPositionLossReached(position))return 'The original position loss allowance has been used.';
  return null;
}

/** Freeze dip thresholds when armed. Distinct fresh receipts can confirm a bounce; repeated books cannot. */
export function advanceTennisAveraging(position:TennisPosition,quote:TennisAveragingQuote,rules:TennisAveragingRules,now:number):{state:TennisAddState;eligible:boolean;reason:string}{
  let state:TennisAddState=structuredClone(position.tennisAdd??newTennisAddState());
  const reject=(reason:string)=>({state,eligible:false,reason});
  const issue=positionIssue(position);if(issue)return reject(issue);
  if(!Number.isFinite(now)||!Number.isFinite(quote.bookTime)||quote.bookTime>now||now-quote.bookTime>rules.maxBookAgeMs||quote.bookTime<position.openedAt
    ||![quote.bid,quote.ask].every(price=>Number.isFinite(price)&&price>0&&price<1)||quote.bid>quote.ask)return reject('Waiting for a fresh coherent Tennis book.');
  if(![rules.drop,rules.recovery,rules.windowMs,rules.maxBookAgeMs].every(value=>Number.isFinite(value)&&value>0)||!Number.isInteger(rules.confirmations)||rules.confirmations<1)
    return reject('Averaging thresholds are unavailable.');
  if(state.lastBookTime!==null&&quote.bookTime<=state.lastBookTime)return reject('Waiting for an independent later book to confirm the bounce.');
  if(position.netLiquidationValue!==null&&position.liquidationQuantity>=position.quantity-EPSILON&&position.markedAt!==null&&position.markedAt<=now&&now-position.markedAt<=rules.maxBookAgeMs&&tennisPositionLossReached(position,position.netLiquidationValue))
    return reject('The original position loss allowance has been used.');
  if(state.armedAt!==null&&now-state.armedAt>rules.windowMs)state={...newTennisAddState(),filledBuys:state.filledBuys,lastBookTime:state.lastBookTime};
  state.lastBookTime=quote.bookTime;
  const drop=state.drop??rules.drop;
  if(quote.ask>position.entryPrice-drop+EPSILON){
    state={...newTennisAddState(),filledBuys:state.filledBuys,lastBookTime:quote.bookTime};
    return reject('Waiting for a lower-priced dip before one additional buy.');
  }
  if(state.armedAt===null){
    state={...state,armedAt:quote.bookTime,drop:rules.drop,recovery:rules.recovery,troughBid:quote.bid,troughAsk:quote.ask,troughAt:quote.bookTime,confirmations:0};
    return reject('A lower-priced dip is armed; waiting for its confirmed bounce.');
  }
  state.troughAsk=Math.min(state.troughAsk??quote.ask,quote.ask);
  if(state.troughBid===null||quote.bid<state.troughBid-EPSILON){state.troughBid=quote.bid;state.troughAt=quote.bookTime;state.confirmations=0;return reject('A new dip low resets the bounce confirmations.');}
  if(quote.bid<state.troughBid+(state.recovery??rules.recovery)-EPSILON){state.confirmations=0;return reject('The lower-priced dip has not recovered enough yet.');}
  state.confirmations++;
  const eligible=state.confirmations>=rules.confirmations;
  return {state,eligible,reason:eligible?'A lower-priced bounce is confirmed for the one additional buy.':'Waiting for another independent confirmation of the lower-priced bounce.'};
}

/** Total purchase cost stays capped at 20% of the original bankroll, including fees and other reservations. */
export function tennisAveragingBudget(session:TennisSession,position:TennisPosition,ignoreOwnPending=false):number{
  if(session.status!=='running'||positionIssue(position)||lossLimitReached(session))return 0;
  const startingCash=walletProjection(session)?.startingCash??session.config.startingCash,commitments=walletCommitments(session,undefined,ignoreOwnPending);
  const initialCost=position.tennisTrend!.initialCost,room=exact(Math.min(startingCash*.2,initialCost*2)-position.entryCost);
  const budget=Math.min(initialCost,room,commitments.available,session.cash);
  return Number.isFinite(budget)?exact(Math.max(0,budget)):0;
}

/** Apply only the actual positive buy. Account cash/journal changes remain the reducer's atomic responsibility. */
export function applyTennisAveragingFill(position:TennisPosition,execution:PaperExecution,approvedBudget:number,now:number):{position:TennisPosition;applied:boolean;reason:string}{
  const unchanged=(reason:string)=>({position,applied:false,reason});
  const issue=positionIssue(position);if(issue)return unchanged(issue);
  if(!Number.isFinite(now)||now<position.openedAt||!Number.isFinite(approvedBudget)||approvedBudget<=0||!execution.apply||execution.replayed||!['filled','partial'].includes(execution.status)
    ||![execution.filledQty,execution.gross,execution.fees,execution.cashDelta].every(Number.isFinite)||execution.filledQty<=0||execution.gross<=0||execution.fees<0||execution.cashDelta>=0)
    return unchanged('The additional buy did not produce an applied positive fill.');
  const cashCost=exact(-execution.cashDelta);
  if(cashCost>approvedBudget+EPSILON||cashCost>position.tennisTrend!.initialCost+EPSILON||position.entryCost+cashCost>position.tennisTrend!.initialCost*2+EPSILON||Math.abs(cashCost-exact(execution.gross+execution.fees))>EPSILON)
    return unchanged('The additional fill exceeded its approved cash budget or has inconsistent purchase costs.');
  const next=structuredClone(position),notional=exact(position.entryCost-position.entryFees+execution.gross);
  next.quantity=exact(position.quantity+execution.filledQty);next.initialQuantity=exact(position.initialQuantity+execution.filledQty);
  next.costBasis=exact(position.costBasis+cashCost);next.entryCost=exact(position.entryCost+cashCost);next.entryFees=exact(position.entryFees+execution.fees);
  next.entryPrice=exact(notional/next.initialQuantity);
  next.tennisAdd={...(position.tennisAdd??newTennisAddState()),filledBuys:1};
  next.netLiquidationValue=null;next.liquidationQuantity=0;next.markedAt=null;
  return {position:next,applied:true,reason:'The one additional buy updated weighted purchase cost; the original dollar loss allowance is unchanged.'};
}

/** A partial exit consumes only its share of remaining weighted cash cost, never the historical purchase total. */
export function tennisExitCostAllocation(position:TennisPosition,filledQty:number):{allocatedCost:number;remainingCostBasis:number;remainingQuantity:number}{
  if(!Number.isFinite(filledQty)||filledQty<=0||filledQty>position.quantity+EPSILON||position.quantity<=0||!Number.isFinite(position.costBasis)||position.costBasis<0)throw new Error('Invalid Tennis exit quantity or cost basis.');
  const full=Math.abs(filledQty-position.quantity)<EPSILON,allocatedCost=full?position.costBasis:exact(position.costBasis*filledQty/position.quantity);
  return {allocatedCost,remainingCostBasis:full?0:exact(position.costBasis-allocatedCost),remainingQuantity:full?0:exact(position.quantity-filledQty)};
}
