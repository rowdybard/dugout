import {applyTennisAction,stepTennisSession} from '../tennis/engine.ts';
import type {TennisAction,TennisInput,TennisSession} from '../tennis/types';
import type {RunnerCause} from './contracts';
import {applyOctopusPicks} from '../tennis/octopus.ts';

/** Service lifecycle adaptation only; signal and execution decisions stay in the
 * shared reducer. Explicit service resume without a duration replaces the old
 * browser observation window, which remains preserved in earlier checkpoints. */
export function reduceRunnerAction(previous:TennisSession,action:TennisAction,inputs:TennisInput[],now:number,cause?:RunnerCause){
  const canStart=action.action==='start'&&previous.status==='idle';
  const canResume=action.action==='resume'&&!['stopped','stopping'].includes(previous.status);
  const clearObservationWindow=(canStart||canResume)&&!('runForMs' in action&&action.runForMs!==undefined)&&!!previous.testRun;
  const base=clearObservationWindow?{...previous,testRun:undefined}:previous;
  // A check may carry Octopus auto picks chosen for it; they are applied first, so replaying the check reproduces them.
  const session=action.action==='tick'?stepTennisSession(applyOctopusPicks(base,action.octopus,now),inputs,now):applyTennisAction(base,action,inputs,now);
  // The service owns one revision stream across account resets. UI polling and
  // compare-and-swap must never mistake a new account for an older response.
  if(session.id!==previous.id)session.revision=previous.revision+1;
  if(action.action==='pause'&&session.status==='paused'&&cause)session.lastReason=cause.code==='FOCUSED_GAME_ENDED'?'The focused game ended. New entries are paused; existing exits remain managed.':'New entries paused at the runner write-budget estimate. Existing exits remain managed.';
  return {session,clearObservationWindow};
}
