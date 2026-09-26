import type {TennisInput} from './types.ts';

/** Provider time orders snapshots; receipt time independently limits their age. */
export function bookOrderIssue(input:TennisInput,previous:number|undefined,now:number):string|null {
  const time=input.sourceTime;
  if(time===undefined||time===null)return previous===undefined?null:'This book has no provider timestamp to compare with the newer saved quote. Waiting for an ordered snapshot.';
  if(!Number.isFinite(time)||time<0||time>now+2000)return 'The provider book timestamp is invalid or ahead of the allowed clock difference.';
  if(previous!==undefined&&time<previous)return 'An older provider book arrived after a newer quote. Ignoring it and waiting for a current snapshot.';
  return null;
}
