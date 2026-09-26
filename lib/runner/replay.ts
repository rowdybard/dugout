import {reduceRunnerAction} from './reducer.ts';
import type {TennisInput,TennisSession} from '../tennis/types';
import type {ReplayFrame} from './contracts';
import {sha256} from './protocol.ts';

/** Exact account replay begins at the migration checkpoint; older receipts do not
 * capture every historical tick and cannot establish full legacy strategy replay. */
export async function replayFrame(before:TennisSession,frame:ReplayFrame,observations:ReadonlyMap<string,TennisInput>):Promise<TennisSession>{
  if(frame.version!==1||frame.sessionId!==before.id||frame.beforeRevision!==before.revision||frame.beforeHash!==await sha256(JSON.stringify(before)))throw new Error('Replay checkpoint differs.');
  const inputs:TennisInput[]=[];
  for(const id of frame.inputIds){const input=observations.get(id);if(!input||await sha256(JSON.stringify(input))!==id)throw new Error('Replay input is missing or changed.');inputs.push(input);}
  const reduced=reduceRunnerAction(before,frame.action,inputs,frame.now,frame.cause),next=reduced.session;
  if(reduced.clearObservationWindow!==!!frame.clearObservationWindow)throw new Error('Replay lifecycle transition differs.');
  // reset is the reducer's only entropy use. Its captured session ID makes that
  // boundary reproducible without altering the paper strategy or timestamps.
  if(frame.resetSessionId){if(frame.action.action!=='reset'||next.id===before.id)throw new Error('Invalid reset replay boundary.');next.id=frame.resetSessionId;}
  if(next.revision!==frame.afterRevision||await sha256(JSON.stringify(next))!==frame.afterHash)throw new Error('Replay result differs.');
  return JSON.parse(JSON.stringify(next)) as TennisSession;
}
