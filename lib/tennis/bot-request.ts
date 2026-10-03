import type {BotId} from './types';

/** Tab selection is a read filter; it never creates a run or changes the wallet. */
export function requestedBot(request:Request):BotId {
  const value=new URL(request.url).searchParams.get('botId');
  if(value===null||value==='football')return 'football';
  if(value==='tennis')return 'tennis';
  throw new Error('Choose the Football or Tennis bot.');
}
