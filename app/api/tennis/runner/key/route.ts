import {env} from 'cloudflare:workers';
import {PolymarketUS} from 'polymarket-us';
import {db} from '@/lib/server/storage';
import {handleFeedKey,polymarketKeyCheck} from '@/lib/runner/feed-key';
import {runnerError} from '@/lib/runner/protocol';
import type {RunnerBindings} from '@/lib/runner/sites-proxy';

/** Set or remove this account's own Polymarket key in its own runner (lib/runner/feed-key.ts). The key is never stored here. */
export async function POST(request:Request){
  try{
    return await handleFeedKey(request,db(),env as RunnerBindings,polymarketKeyCheck(secrets=>new PolymarketUS({...secrets,timeout:8000}).account.balances()));
  }catch(error){return runnerError(error);}
}
