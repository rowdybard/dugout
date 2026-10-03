import type {BotId,TennisIntent,TennisPosition,TennisSession} from './types';
import type {MakerState} from './maker';

/** Reducer-only context. WeakMap storage keeps projections out of persisted state and exports. */
export type WalletProjection={botId:BotId;otherPositions:TennisPosition[];otherPending:TennisIntent[];otherResting:number;startingCash:number;lossFraction:number;now:number};
const projections=new WeakMap<TennisSession,WalletProjection>();
const mainMakers=new WeakMap<TennisSession,MakerState>();
const exact=(value:number)=>Math.round(value*1e6)/1e6;
export const walletProjection=(session:TennisSession)=>projections.get(session);
export function bindWalletProjection(session:TennisSession,projection:WalletProjection|undefined){if(projection)projections.set(session,projection);return session;}
export function copyWalletProjection(from:TennisSession,to:TennisSession){return bindWalletProjection(to,projections.get(from));}
export function walletMainMaker(session:TennisSession,main:MakerState|undefined){if(main)mainMakers.set(session,main);else mainMakers.delete(session);}
export const quoteCommitment=(state:MakerState|undefined)=>state?exact(Object.values(state.quotes).reduce((sum,quote)=>sum+quote.quantity*quote.price,0)):0;
export function restingCommitments(session:TennisSession,exclude?:MakerState):number {
  const states=new Set([session.maker,...Object.values(session.chaos??{}),mainMakers.get(session)]);
  return exact([...states].reduce((sum,state)=>sum+(state!==exclude?quoteCommitment(state):0),0));
}
export const openCommitments=(positions:TennisPosition[])=>exact(positions.filter(p=>p.status==='open').reduce((sum,p)=>sum+p.costBasis,0));
export const pendingCommitment=(intent:TennisIntent|null|undefined)=>intent?.action==='BUY'?intent.budget??0:0;
export function walletEquity(session:TennisSession):number {
  const positions=[...session.positions,...(walletProjection(session)?.otherPositions??[])];
  return exact(session.cash+positions.filter(p=>p.status==='open').reduce((sum,p)=>sum+(p.netLiquidationValue??0),0));
}
export function walletCommitments(session:TennisSession,exclude?:MakerState,ignoreOwnPending=false){
  const projection=walletProjection(session),open=openCommitments(session.positions)+openCommitments(projection?.otherPositions??[]);
  const pending=(ignoreOwnPending?0:pendingCommitment(session.pending))+(projection?.otherPending??[]).reduce((sum,p)=>sum+pendingCommitment(p),0);
  const resting=restingCommitments(session,exclude)+(projection?.otherResting??0);
  const total=exact(open+pending+resting),cap=exact(Math.max(0,Math.min(projection?.startingCash??session.config.startingCash,walletEquity(session))*.5));
  return {open:exact(open),pending:exact(pending),resting:exact(resting),total,cap,
    available:exact(Math.max(0,Math.min(cap-total,session.cash-pending-resting)))};
}
export function otherMarksComplete(session:TennisSession):boolean {
  const projection=walletProjection(session);if(!projection)return true;
  return projection.otherPositions.filter(p=>p.status==='open').every(p=>p.netLiquidationValue!==null&&p.liquidationQuantity>=p.quantity-1e-7&&p.markedAt!==null&&p.markedAt<=projection.now&&projection.now-p.markedAt<=5000);
}
