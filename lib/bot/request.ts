import type {Profile} from '../market/types';

/** A lost POST response is ambiguous. Recover state without resending the command. */
export async function requestBot(command:Record<string,unknown>,fetcher:typeof fetch=fetch):Promise<{ok:boolean;profile?:Profile;error?:string}>{
  try{
    const response=await fetcher('/api/bot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(30000)});
    const data=await response.json() as {error?:string;profile?:Profile};
    if(!response.ok)return {ok:false,error:data.error??'The bot could not complete that action.'};
    if(!data.profile)throw new Error('Missing saved bot status.');
    return {ok:true,profile:data.profile};
  }catch{
    try{
      const recovery=await fetcher('/api/bot',{cache:'no-store',signal:AbortSignal.timeout(8000)});
      if(!recovery.ok)throw new Error('Status unavailable');
      const data=await recovery.json() as {profile?:Profile};
      if(!data.profile)throw new Error('Missing status');
      return {ok:false,profile:data.profile,error:'Connection interrupted. Saved bot status restored; check its status before retrying a control.'};
    }catch{return {ok:false,error:'Connection interrupted. Saved status could not be checked. Refresh before retrying a control.'};}
  }
}
