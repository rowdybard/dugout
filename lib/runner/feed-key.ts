import {requireRunnerUser} from '../server/owner-access.ts';
import {verifyCredentials} from '../trading/credentials.ts';
import {boundedBody,RunnerError} from './protocol.ts';
import {readOwnerFence,requireRunnerOrigin,requireSitesOwner,runnerRequest} from './sites-proxy.ts';
import type {RunnerBindings,RunnerDatabase} from './sites-proxy';
import type {CredentialStatus} from '../trading/credentials';

/**
 * A person's own Polymarket US key for their own runner's live price stream (POST /api/tennis/runner/key).
 *
 * The key goes from the browser to this server once, is checked with a read-only balance request, and is passed over
 * the signed channel to that person's runner, which stores it encrypted (AES-GCM, a key derived from the runner
 * secret, the account and its epoch). The site keeps no copy: nothing is written to the database or logs, and no
 * response contains it. The runner only reports whether a key is set. Only the signed-in account can set or remove
 * its own key, and only from this site (origin checked).
 */
export type KeyCheck=(secrets:{keyId:string;secretKey:string})=>Promise<CredentialStatus>;

export async function handleFeedKey(request:Request,database:RunnerDatabase,env:RunnerBindings,check:KeyCheck,send:typeof runnerRequest=runnerRequest):Promise<Response>{
  const owner=requireSitesOwner(request);
  if(request.method!=='POST')throw new RunnerError(405,'Unsupported method.');
  requireRunnerOrigin(request);
  requireRunnerUser(owner,env);
  const fence=await readOwnerFence(database,owner);
  if(!fence||fence.mode!=='active')throw new RunnerError(409,'Turn on background running first; the key is kept in your own runner.');
  let input:{keyId?:unknown;secretKey?:unknown;remove?:unknown};
  try{input=JSON.parse(await boundedBody(request,1024));}catch{throw new RunnerError(400,'Invalid key request.');}
  const headers={'Cache-Control':'no-store'};
  if(input&&input.remove===true&&Object.keys(input).length===1){
    await send(env,owner,fence.epoch,'/v1/feed-credentials','POST',{remove:true});
    return Response.json({feedKey:false},{headers});
  }
  const keyId=typeof input?.keyId==='string'?input.keyId.trim():'',secretKey=typeof input?.secretKey==='string'?input.secretKey.trim():'';
  if(!input||Object.keys(input).length!==2||!/^[a-zA-Z0-9_-]{1,200}$/.test(keyId)||!secretKey||secretKey.length>128)
    throw new RunnerError(400,'Enter the key ID and the secret key from Polymarket US.');
  const status=await check({keyId,secretKey});
  if(status.state!=='verified')throw new RunnerError(400,status.message);
  await send(env,owner,fence.epoch,'/v1/feed-credentials','POST',{keyId,secretKey});
  return Response.json({feedKey:true},{headers});
}

/** The real check: a read-only balance request with the key (lib/trading/credentials.ts). */
export function polymarketKeyCheck(readAccount:(secrets:{keyId:string;secretKey:string})=>Promise<unknown>):KeyCheck {
  return secrets=>verifyCredentials({POLYMARKET_KEY_ID:secrets.keyId,POLYMARKET_SECRET_KEY:secrets.secretKey},readAccount);
}
