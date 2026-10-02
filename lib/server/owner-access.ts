import {RunnerError} from '../runner/protocol.ts';
import {runnerAllowed} from '../runner/owners.ts';

export type SiteOwnerBindings={DUGOUT_OWNER_ID?:string;DUGOUT_RUNNER_USERS?:string};

/** Only the deployment's pinned Sites identity may use owner-funded extras. */
export function siteOwnerEnabled(owner:string,env:SiteOwnerBindings):boolean{
  const pinned=env.DUGOUT_OWNER_ID;
  return typeof pinned==='string'&&/^[a-zA-Z0-9_-]{8,160}$/.test(pinned)&&pinned===owner;
}

/**
 * Signed market streams use the owner's Polymarket US key and open one upstream connection each, so only the
 * pinned owner may open them. Everyone else keeps the bounded REST quote checks.
 */
export function streamOwnerIssue(request:Request,env:SiteOwnerBindings):Response|null{
  const owner=request.headers.get('oai-authenticated-user-id')??'';
  return siteOwnerEnabled(owner,env)?null:Response.json({error:'Live streaming is limited to the site owner. Quotes still refresh over REST.'},{status:403,headers:{'Cache-Control':'no-store'}});
}

/** Background runner: the owner, plus DUGOUT_RUNNER_USERS ("*" or account ids). Paid extras stay owner-only. */
export function runnerUserEnabled(owner:string,env:SiteOwnerBindings):boolean{
  return runnerAllowed(owner,env.DUGOUT_OWNER_ID,env.DUGOUT_RUNNER_USERS);
}
export function requireRunnerUser(owner:string,env:SiteOwnerBindings):void{
  if(!runnerUserEnabled(owner,env))throw new RunnerError(403,'Background running is not enabled for this account. Your paper bot works while this page is open and visible.');
}

export function requireSiteOwner(owner:string,env:SiteOwnerBindings):void{
  if(!siteOwnerEnabled(owner,env))throw new RunnerError(403,'This feature is available only to the site owner. Your paper bot works while this page is open and visible.');
}
