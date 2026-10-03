import type {TennisSession} from './types';
import {otherMarksComplete,walletProjection} from './wallet-risk.ts';

const exact=(value:number)=>Math.round(value*1e6)/1e6;
const storedPrecision=(session:TennisSession)=>!!session.lossCheckpoint||!!session.bots||!!walletProjection(session);

/** The saved loss fraction controls the allowance, always using this run's original starting balance. */
export function lossAllowance(session:TennisSession):number {
  const projection=walletProjection(session),allowance=(projection?.startingCash??session.config.startingCash)*(projection?.lossFraction??session.config.maxSessionLossFraction);
  // Legacy periods retain their existing arithmetic; acknowledged periods use stored money precision.
  return storedPrecision(session)?exact(allowance):allowance;
}

export function lossFloor(session:TennisSession):number {
  const floor=(session.lossCheckpoint?.cash??session.config.startingCash)-lossAllowance(session);
  return storedPrecision(session)?exact(floor):floor;
}

export function realizedPnl(session:TennisSession):number {
  const pnl=[...session.positions,...(walletProjection(session)?.otherPositions??[])].reduce((sum,position)=>sum+position.realizedPnl,0);
  return storedPrecision(session)?exact(pnl):pnl;
}

export function dayPnl(session:TennisSession,utcDay:string):number {
  return session.ledger.filter(entry=>new Date(entry.time).toISOString().slice(0,10)===utcDay).reduce((sum,entry)=>sum+entry.realizedPnl,0);
}

/** Checkpoint differences use the same six decimal places as stored ledger money. */
export function sessionPnl(session:TennisSession):number {
  const pnl=realizedPnl(session);
  return storedPrecision(session)?exact(pnl-(session.lossCheckpoint?.realizedPnl??0)):pnl;
}

export function dayRiskPnl(session:TennisSession,utcDay:string):number {
  const pnl=dayPnl(session,utcDay);
  return session.lossCheckpoint?.utcDay===utcDay?exact(pnl-session.lossCheckpoint.dayPnl):storedPrecision(session)?exact(pnl):pnl;
}

/** Missing or partial marks do not invent a loss; realised losses still stop the bot. */
export function lossLimitReached(session:TennisSession,markedEquity?:number|null):boolean {
  const sinceAcknowledgement=sessionPnl(session);
  return sinceAcknowledgement<=-lossAllowance(session)
    || otherMarksComplete(session)&&typeof markedEquity==='number'&&Number.isFinite(markedEquity)&&markedEquity<=lossFloor(session);
}

/** A dip buy cannot consume loss room already lost in this shared account period. */
export function remainingLossAllowance(session:TennisSession,markedEquity?:number|null):number {
  const room=Math.max(0,exact(lossAllowance(session)+Math.min(0,sessionPnl(session))));
  return otherMarksComplete(session)&&typeof markedEquity==='number'&&Number.isFinite(markedEquity)?Math.min(room,Math.max(0,exact(markedEquity-lossFloor(session)))):room;
}

/** Only a completed loss stop can be acknowledged. Existing exits must finish first. */
export function canAcknowledgeLoss(session:TennisSession):boolean {
  return session.status==='stopped'&&Number.isFinite(session.cash)&&session.cash>0
    && ![...session.positions,...(walletProjection(session)?.otherPositions??[])].some(position=>position.status==='open')&&!session.pending&&!(walletProjection(session)?.otherPending.length)&&session.exitAll===undefined&&!session.exitRequested
    &&lossLimitReached(session,session.cash);
}
