import type {TennisSession} from './types';

const exact=(value:number)=>Math.round(value*1e6)/1e6;

/** The saved loss fraction controls the allowance, always using this run's original starting balance. */
export function lossAllowance(session:TennisSession):number {
  const allowance=session.config.startingCash*session.config.maxSessionLossFraction;
  // Legacy periods retain their existing arithmetic; acknowledged periods use stored money precision.
  return session.lossCheckpoint?exact(allowance):allowance;
}

export function lossFloor(session:TennisSession):number {
  const floor=(session.lossCheckpoint?.cash??session.config.startingCash)-lossAllowance(session);
  return session.lossCheckpoint?exact(floor):floor;
}

export const realizedPnl=(session:TennisSession):number=>session.positions.reduce((sum,position)=>sum+position.realizedPnl,0);

export function dayPnl(session:TennisSession,utcDay:string):number {
  return session.ledger.filter(entry=>new Date(entry.time).toISOString().slice(0,10)===utcDay).reduce((sum,entry)=>sum+entry.realizedPnl,0);
}

/** Checkpoint differences use the same six decimal places as stored ledger money. */
export function sessionPnl(session:TennisSession):number {
  const pnl=realizedPnl(session);
  return session.lossCheckpoint?exact(pnl-session.lossCheckpoint.realizedPnl):pnl;
}

export function dayRiskPnl(session:TennisSession,utcDay:string):number {
  const pnl=dayPnl(session,utcDay);
  return session.lossCheckpoint?.utcDay===utcDay?exact(pnl-session.lossCheckpoint.dayPnl):pnl;
}

/** Missing or partial marks do not invent a loss; realised losses still stop the bot. */
export function lossLimitReached(session:TennisSession,markedEquity?:number|null):boolean {
  const sinceAcknowledgement=sessionPnl(session);
  return sinceAcknowledgement<=-lossAllowance(session)
    || typeof markedEquity==='number'&&Number.isFinite(markedEquity)&&markedEquity<=lossFloor(session);
}

/** Only a completed loss stop can be acknowledged. Existing exits must finish first. */
export function canAcknowledgeLoss(session:TennisSession):boolean {
  return session.status==='stopped'&&Number.isFinite(session.cash)&&session.cash>0
    && !session.positions.some(position=>position.status==='open')&&!session.pending&&session.exitAll===undefined&&!session.exitRequested
    &&lossLimitReached(session,session.cash);
}
