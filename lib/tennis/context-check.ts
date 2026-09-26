/** Feed-check receipt time is independent of the provider's play-report time. */
export type ContextCheckState={successfulCheckAt:number|null;error:string|null};
export type ContextCheckResult={successfulCheckAt?:number|null;error?:string|null};

export function recordContextCheck(previous:ContextCheckState|undefined,result:ContextCheckResult):ContextCheckState{
  const supplied=result.successfulCheckAt;
  const successfulCheckAt=typeof supplied==='number'&&Number.isFinite(supplied)&&supplied>=0
    ?Math.max(previous?.successfulCheckAt??0,supplied):previous?.successfulCheckAt??null;
  // A failed response can carry a prior successful source check from the server.
  // Neither a cache hit nor a failed request substitutes its response time here.
  return {successfulCheckAt,error:result.error||null};
}

const ageText=(ms:number)=>ms<60_000?`${Math.floor(ms/1000)}s`:ms<3_600_000?`${Math.floor(ms/60_000)}m ${Math.floor(ms%60_000/1000)}s`:`${Math.floor(ms/3_600_000)}h ${Math.floor(ms%3_600_000/60_000)}m`;

export function contextCheckView(check:ContextCheckState|undefined,now:number,report:{freshness:'fresh'|'stale'|'unknown'|'conflicting';live:boolean;ended:boolean}){
  const timestamp=check?.successfulCheckAt;
  // Small server/client clock differences should not render a negative age.
  const ageMs=typeof timestamp==='number'&&Number.isFinite(timestamp)&&timestamp>=0&&Number.isFinite(now)&&timestamp<=now+30_000?Math.max(0,now-timestamp):null;
  const checkedLabel=ageMs===null?'Not verified yet':`${ageText(ageMs)} ago`;
  const failed=Boolean(check?.error);
  const message=failed?'Latest check failed. Showing the last available game report.'
    :report.ended?'Game ended; showing the final available report.'
    :!report.live?'Waiting for the game to be in play.'
    :report.freshness==='conflicting'?'Waiting for the game reports to agree.'
    :report.freshness==='unknown'?'Waiting for a verified game report.'
    :ageMs===null?'Waiting for a successful game-feed check.'
    :report.freshness==='stale'?ageMs<=15_000?'Game feed checked; waiting for a newer play report.':'Waiting for the next game-feed check.'
    :'Markers update when the provider sends a new play report.';
  return {ageMs,checkedLabel,failed,message};
}
