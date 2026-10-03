import {applyTennisAction,stepTennisSession} from '../tennis/engine.ts';
import type {TennisAction,TennisInput,TennisSession} from '../tennis/types';
import type {RunnerCause} from './contracts';
import {applyOctopusPicks} from '../tennis/octopus.ts';
import {accountBotView,applyAccountAction,stepAccountSession} from '../tennis/account.ts';
import type {BotId} from '../tennis/types';

function botPatch(session:TennisSession,botId:BotId,patch:Partial<TennisSession>):TennisSession {
  if(botId==='football')return {...session,...patch};
  if(!session.bots?.tennis)return session;
  return {...session,bots:{...session.bots,tennis:{...session.bots.tennis,...patch}}};
}

function reduceAccount(previous:TennisSession,action:TennisAction,inputs:TennisInput[],now:number,cause?:RunnerCause){
  const botId=action.botId??'football',before=accountBotView(previous,botId);
  const indefinite=!('runForMs' in action&&action.runForMs!==undefined);
  let clearObservationWindow=indefinite&&!!before.testRun&&(action.action==='start'&&before.status==='idle'||action.action==='resume'&&!['stopped','stopping'].includes(before.status));
  const base=clearObservationWindow?botPatch(previous,botId,{testRun:undefined}):previous;
  let session=action.action==='tick'?stepAccountSession(applyOctopusPicks(base,action.octopus,now),inputs,now):applyAccountAction(base,action,inputs,now);
  const after=accountBotView(session,botId);
  // Stopped Start validates its rules before replacing a completed window.
  if((action.action==='acknowledge-loss'||action.action==='start')&&before.status==='stopped'&&after.status==='running'&&session.id===previous.id&&session.revision>previous.revision&&indefinite&&before.testRun){
    clearObservationWindow=true;session=botPatch(session,botId,{testRun:undefined});
  }
  if(session.id!==previous.id)session.revision=previous.revision+1;
  if(action.action==='pause'&&after.status==='paused'&&cause)session=botPatch(session,botId,{lastReason:cause.code==='FOCUSED_GAME_ENDED'?'The focused game ended. New entries are paused; existing exits remain managed.':'New entries paused at the runner write-budget estimate. Existing exits remain managed.'});
  return {session,clearObservationWindow};
}

/** Service lifecycle adaptation only; signal and execution decisions stay in the
 * shared reducer. Explicit service resume or valid loss acknowledgement without a duration replaces the old
 * browser observation window, which remains preserved in earlier checkpoints.
 * An upgraded stopped bot's valid Start follows the same service transition. */
export function reduceRunnerAction(previous:TennisSession,action:TennisAction,inputs:TennisInput[],now:number,cause?:RunnerCause){
  if(previous.bots||action.botId)return reduceAccount(previous,action,inputs,now,cause);
  const canStart=action.action==='start'&&previous.status==='idle';
  const canResume=action.action==='resume'&&!['stopped','stopping'].includes(previous.status);
  const indefinite=!('runForMs' in action&&action.runForMs!==undefined);
  let clearObservationWindow=(canStart||canResume)&&indefinite&&!!previous.testRun;
  const base=clearObservationWindow?{...previous,testRun:undefined}:previous;
  // A check may carry Octopus auto picks chosen for it; they are applied first, so replaying the check reproduces them.
  let session=action.action==='tick'?stepTennisSession(applyOctopusPicks(base,action.octopus,now),inputs,now):applyTennisAction(base,action,inputs,now);
  // A rejected acknowledgement keeps the completed observation window. Only
  // the successful transition may replace it with an indefinite service run.
  if(action.action==='acknowledge-loss'&&previous.status==='stopped'&&session.status==='running'&&session.id===previous.id&&session.revision>previous.revision&&indefinite&&previous.testRun){
    clearObservationWindow=true;session={...session,testRun:undefined};
  }
  // The service owns one revision stream across account resets. UI polling and
  // compare-and-swap must never mistake a new account for an older response.
  if(session.id!==previous.id)session.revision=previous.revision+1;
  if(action.action==='pause'&&session.status==='paused'&&cause)session.lastReason=cause.code==='FOCUSED_GAME_ENDED'?'The focused game ended. New entries are paused; existing exits remain managed.':'New entries paused at the runner write-budget estimate. Existing exits remain managed.';
  return {session,clearObservationWindow};
}
