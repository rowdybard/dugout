import {applyTennisAction,stepTennisSession} from '../tennis/engine.ts';
import type {TennisAction,TennisInput,TennisSession} from '../tennis/types';
import type {RunnerCause} from './contracts';
import {applyOctopusPicks} from '../tennis/octopus.ts';

/** Service lifecycle adaptation only; signal and execution decisions stay in the
 * shared reducer. Explicit service resume or valid loss acknowledgement without a duration replaces the old
 * browser observation window, which remains preserved in earlier checkpoints. */
export function reduceRunnerAction(previous:TennisSession,action:TennisAction,inputs:TennisInput[],now:number,cause?:RunnerCause){
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
