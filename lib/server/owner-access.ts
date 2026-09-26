import {RunnerError} from '../runner/protocol.ts';

export type SiteOwnerBindings={DUGOUT_OWNER_ID?:string};

/** Only the deployment's pinned Sites identity may use owner-funded extras. */
export function siteOwnerEnabled(owner:string,env:SiteOwnerBindings):boolean{
  const pinned=env.DUGOUT_OWNER_ID;
  return typeof pinned==='string'&&/^[a-zA-Z0-9_-]{8,160}$/.test(pinned)&&pinned===owner;
}

export function requireSiteOwner(owner:string,env:SiteOwnerBindings):void{
  if(!siteOwnerEnabled(owner,env))throw new RunnerError(403,'This feature is available only to the site owner. Your paper bot works while this page is open and visible.');
}
