import {applyTennisAction,createTennisSession,stepTennisSession} from './engine.ts';
import {defaultTennisBotConfig} from './rules.ts';
import {lossLimitReached} from './loss-limit.ts';
import {quoteCommitment,restingCommitments,walletCommitments,type WalletProjection} from './wallet-risk.ts';
import type {BotId,TennisAction,TennisBotState,TennisInput,TennisSession} from './types';

const sharedKeys=new Set(['bots','accountLossStops','id','revision','mode','cash','positions','ledger','equity','commandIds','lossCheckpoint','decisions']);
const exact=(value:number)=>Math.round(value*1e6)/1e6;
const owner=(row:{botId?:BotId})=>row.botId??'football';
const botState=(session:TennisSession):TennisBotState=>Object.fromEntries(Object.entries(session).filter(([key])=>!sharedKeys.has(key))) as TennisBotState;
const emptyTennis=(account:TennisSession)=>botState(createTennisSession(defaultTennisBotConfig(account.config.startingCash),account.startedAt));
function botInputs(view:TennisSession,botId:BotId,inputs:TennisInput[]){
  const protectedSlugs=new Set(view.positions.filter(position=>position.status==='open').map(position=>position.slug));
  if(view.pending)protectedSlugs.add(view.pending.slug);
  return inputs.filter(input=>protectedSlugs.has(input.market.slug)||(botId==='tennis'?['ATP','WTA'].includes(input.market.league):!['ATP','WTA'].includes(input.market.league)));
}

export function accountBotIds(account:TennisSession):BotId[]{return account.bots?.tennis?['football','tennis']:['football'];}

/** A display projection: root account remains the source for wallet totals and all-bot history. */
export function accountBotView(account:TennisSession,botId:BotId):TennisSession {
  const view=structuredClone(account);delete view.bots;delete view.accountLossStops;
  if(botId==='tennis'){
    // Missing optional Tennis state must not inherit Football timers, maker orders or exit requests.
    for(const key of Object.keys(botState(view)))delete (view as unknown as Record<string,unknown>)[key];
    Object.assign(view,structuredClone(account.bots?.tennis??emptyTennis(account)));
  }
  view.positions=account.positions.filter(row=>owner(row)===botId).map(row=>structuredClone(row));
  view.decisions=account.decisions.filter(row=>owner(row)===botId).map(row=>structuredClone(row));
  view.ledger=account.ledger.filter(row=>owner(row)===botId).map(row=>structuredClone(row));
  view.config.startingCash=account.config.startingCash;view.config.maxSessionLossFraction=account.config.maxSessionLossFraction;
  return view;
}

export function accountCommitments(account:TennisSession){
  const result=walletCommitments(account),tennis=account.bots?.tennis;
  if(!tennis)return result;
  const pending=tennis.pending?.action==='BUY'?tennis.pending.budget??0:0;
  const resting=quoteCommitment(tennis.maker)+Object.values(tennis.chaos??{}).reduce((sum,state)=>sum+quoteCommitment(state),0);
  const total=exact(result.total+pending+resting);
  return {...result,pending:exact(result.pending+pending),resting:exact(result.resting+resting),total,
    available:exact(Math.max(0,Math.min(result.cap-total,account.cash-result.pending-result.resting-pending-resting)))};
}

function projection(account:TennisSession,botId:BotId,now:number){
  const view=accountBotView(account,botId),others=accountBotIds(account).filter(id=>id!==botId).map(id=>accountBotView(account,id));
  view.id=account.id+':'+botId;
  // Execution checks and daily risk use the complete account ledger, not the display projection.
  view.ledger=structuredClone(account.ledger);view.commandIds=[...account.commandIds];
  const risk:WalletProjection={botId,otherPositions:account.positions.filter(row=>owner(row)!==botId),otherPending:others.flatMap(bot=>bot.pending?[bot.pending]:[]),
    otherResting:others.reduce((sum,bot)=>sum+restingCommitments(bot),0),startingCash:account.config.startingCash,lossFraction:account.config.maxSessionLossFraction,now};
  return {view,risk};
}

function merge(account:TennisSession,botId:BotId,next:TennisSession):TennisSession {
  const positions=new Set(account.positions.map(row=>row.id)),decisions=new Set(account.decisions.map(row=>row.id)),ledger=new Set(account.ledger.map(row=>row.id));
  const result=structuredClone(account),state=botState(next);
  if(botId==='football'){
    for(const key of Object.keys(botState(result)))delete (result as unknown as Record<string,unknown>)[key];
    Object.assign(result,state);
  }else result.bots={...result.bots,tennis:state};
  result.cash=next.cash;result.lossCheckpoint=next.lossCheckpoint;result.commandIds=[...next.commandIds];result.equity=next.equity;
  result.positions=[...account.positions.filter(row=>owner(row)!==botId),...next.positions.map(row=>positions.has(row.id)?row:{...row,botId})];
  result.ledger=next.ledger.map(row=>ledger.has(row.id)?row:{...row,botId});
  result.decisions=[...account.decisions.filter(row=>owner(row)!==botId),...next.decisions.map(row=>decisions.has(row.id)?row:{...row,botId})]
    .sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id)).slice(-300);
  result.startedAt=account.startedAt;result.lastTickAt=Math.max(account.lastTickAt,next.lastTickAt);result.revision=account.revision;
  return result;
}

function allFlat(account:TennisSession):boolean {
  return !account.positions.some(p=>p.status==='open')&&accountBotIds(account).every(id=>{
    const bot=accountBotView(account,id);return !bot.pending&&!bot.exitRequested&&bot.exitAll===undefined&&restingCommitments(bot)===0;
  });
}

function lossStop(account:TennisSession,now:number,activeBots:BotId[]=[]):TennisSession {
  const fullyMarked=account.positions.filter(p=>p.status==='open').every(p=>p.netLiquidationValue!==null&&p.liquidationQuantity>=p.quantity-1e-7&&p.markedAt!==null&&p.markedAt<=now&&now-p.markedAt<=5000);
  const equity=fullyMarked?account.cash+account.positions.filter(p=>p.status==='open').reduce((sum,p)=>sum+(p.netLiquidationValue??0),0):null;
  if(!lossLimitReached(account,equity))return account;
  const result=structuredClone(account),stopped=new Set(account.accountLossStops??[]);
  for(const id of accountBotIds(account)){
    const bot=accountBotView(result,id);
    if(bot.status==='idle'||bot.status==='stopped'&&!stopped.has(id)&&!activeBots.includes(id))continue;
    stopped.add(id);bot.status=bot.positions.some(p=>p.status==='open')?'stopping':'stopped';
    if(bot.pending?.action==='BUY')bot.pending=null;
    if(bot.maker)bot.maker.quotes={};for(const state of Object.values(bot.chaos??{}))state.quotes={};
    bot.lastReason='The shared account reached its loss limit. Both bots stop entries while remaining positions close.';
    if(id==='football')Object.assign(result,botState(bot));else result.bots={...result.bots,tennis:botState(bot)};
  }
  result.accountLossStops=[...stopped];return result;
}

function reject(previous:TennisSession,action:TennisAction,reason:string,now:number):TennisSession {
  const result=structuredClone(previous),id=action.botId??'football';
  if(id==='tennis')result.bots={...result.bots,tennis:{...(result.bots?.tennis??emptyTennis(result)),lastReason:reason,lastTickAt:now}};
  else result.lastReason=reason;
  result.revision++;result.lastTickAt=now;if(action.commandId)result.commandIds.push(action.commandId);return result;
}

/** One deterministic account revision: football first, then tennis with the resulting wallet. */
export function stepAccountSession(previous:TennisSession,inputs:TennisInput[],now:number):TennisSession {
  if(!previous.bots)return stepTennisSession(previous,inputs,now);
  if(!Number.isFinite(now)||now<previous.lastTickAt)return previous;
  let account=lossStop(previous,now);
  for(const id of accountBotIds(account)){
    const {view,risk}=projection(account,id,now),allowed=botInputs(view,id,inputs);
    account=merge(account,id,stepTennisSession(view,allowed,now,risk));account=lossStop(account,now,!['idle','stopped'].includes(view.status)?[id]:[]);
  }
  account.revision=previous.revision+1;account.lastTickAt=now;return account;
}

export function applyAccountAction(previous:TennisSession,action:TennisAction,inputs:TennisInput[],now:number):TennisSession {
  if(!previous.bots&&action.botId===undefined)return applyTennisAction(previous,action,inputs,now);
  if(!Number.isFinite(now)||now<previous.lastTickAt||action.botId!==undefined&&!['football','tennis'].includes(action.botId))return previous;
  if('sessionId' in action&&action.sessionId&&action.sessionId!==previous.id)return previous;
  if(action.action==='acknowledge-loss'&&(action.sessionId!==previous.id||!action.commandId))return previous;
  if(action.commandId&&previous.commandIds.includes(action.commandId))return previous;
  if(action.action==='acknowledge-loss'&&action.expectedLossAcknowledgement!==(previous.lossCheckpoint?.commandId??null))return previous;
  let account=structuredClone(previous);account.bots??={};
  const botId=action.botId??'football';
  if(action.action==='tick'){
    const next=stepAccountSession(account,inputs,now);if(action.commandId)next.commandIds.push(action.commandId);return next;
  }
  if(action.action==='reset'){
    if(!action.abandon&&!allFlat(account))return reject(account,action,'Close both bots’ positions and orders before resetting the shared paper account.',now);
    const next=applyTennisAction(account,{...action,botId:undefined},[],now);
    if(next.id===account.id)return next;
    next.bots={};if(account.bots?.tennis)next.bots.tennis=botState(createTennisSession(defaultTennisBotConfig(action.bankroll,account.bots.tennis.config.tennisStrategy??'auto'),now));
    next.revision=previous.revision+1;return next;
  }
  if(action.action==='exit-now'){
    for(const id of accountBotIds(account)){
      const {view,risk}=projection(account,id,now);
      if(view.status==='running')view.status='paused';if(view.pending?.action==='BUY')view.pending=null;
      if(view.maker)view.maker.quotes={};for(const state of Object.values(view.chaos??{}))state.quotes={};
      view.commandIds=view.commandIds.filter(command=>command!==action.commandId);
      const allowed=botInputs(view,id,inputs);
      account=merge(account,id,applyTennisAction(view,action,allowed,now,risk));
    }
    account.revision=previous.revision+1;account.lastTickAt=now;return lossStop(account,now);
  }
  if(botId==='tennis')account.bots.tennis??=emptyTennis(account);
  if(action.action==='acknowledge-loss'&&!allFlat(account))return reject(account,action,'Both bots must finish closing positions and exit orders before acknowledging the shared loss.',now);
  if(action.action==='start'&&lossLimitReached(account,allFlat(account)?account.cash:null))return reject(account,action,'Acknowledge the shared account loss before starting a bot with the remaining paper cash.',now);
  const {view,risk}=projection(account,botId,now),internalAction='sessionId' in action?{...action,sessionId:view.id}:action;
  const originalStatus=view.status,oldWindow=view.testRun;
  if(action.action==='start'&&view.status==='stopped'&&!account.accountLossStops?.includes(botId)&&!lossLimitReached(account,allFlat(account)?account.cash:null))view.status='idle';
  const replaceWindow=action.action==='start'&&view.status==='idle'&&action.runForMs===undefined;
  if(replaceWindow)delete view.testRun;
  const allowed=botInputs(view,botId,inputs);
  const next=applyTennisAction(view,internalAction,allowed,now,risk);
  if(action.action==='start'&&next.status==='idle'){
    next.status=originalStatus;if(replaceWindow&&oldWindow)next.testRun=oldWindow;
  }
  account=merge(account,botId,next);
  if(action.action==='update-rules'&&next.rulesRevision!==(view.rulesRevision??0)&&action.rules.maxSessionLossFraction!==undefined){
    account.config.maxSessionLossFraction=next.config.maxSessionLossFraction;if(account.bots?.tennis)account.bots.tennis.config.maxSessionLossFraction=next.config.maxSessionLossFraction;
  }
  if(action.action==='acknowledge-loss'&&next.lossCheckpoint?.commandId===action.commandId&&next.status==='running'){
    for(const id of account.accountLossStops??[]){if(id===botId)continue;const bot=accountBotView(account,id);if(bot.status==='stopped'){
      bot.status='paused';bot.lastReason='The shared loss was acknowledged. This bot stays paused until you explicitly Resume it.';
      if(id==='football')Object.assign(account,botState(bot));else account.bots={...account.bots,tennis:botState(bot)};
    }}delete account.accountLossStops;
  }
  account=lossStop(account,now,action.action!=='stop'&&(!['idle','stopped'].includes(view.status)||action.action==='start'||action.action==='resume')?[botId]:[]);account.revision=previous.revision+1;account.lastTickAt=now;return account;
}
