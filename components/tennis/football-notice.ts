import {footballFieldView,type FootballFieldMarket} from '../../lib/tennis/football-field.ts';
import type {FootballAssessment} from '../../lib/tennis/types';
import type {ContextCheckState} from '../../lib/tennis/context-check';
import {footballSourceTimingIssue} from '../../lib/tennis/football-context.ts';

export const isFootballFreshnessReason=(text:string|undefined|null)=>!!text&&/\b(?:football|ESPN|Polymarket|scoreboard|game reports?|drive reports?|source timestamps|drive details|possession|scrimmage down|field position)\b/i.test(text)&&/\b(?:older|stale|waiting|unverified|invalid|conflicting|mismatch|missing|fresh|updated|aligned|coherent|supplied|supply|report)\b/i.test(text);

/** One primary feed status; individual source ages remain factual labels below it. */
export function footballFreshnessNotice(market:FootballFieldMarket,now:number,assessment?:FootballAssessment,check?:ContextCheckState,savedReason?:string):string|null {
  if(!market.live||market.ended||market.league!=='CFB'&&market.league!=='NFL')return null;
  const field=footballFieldView(market,now,assessment);
  if(check?.error)return `Game-feed check failed: ${check.error.replace(/\.$/,'')}. Showing the last available report.`;
  const sources=market.footballSources;
  const timing=sources?footballSourceTimingIssue(sources,now):null;
  if(timing){
    if(/ahead/.test(timing.reason))return 'The drive update is ahead of the Polymarket scoreboard. Waiting for aligned updates.';
    if(/scoreboard (?:report|receipt)/.test(timing.reason))return 'Waiting for an updated Polymarket scoreboard.';
    if(/drive (?:report|receipt)/.test(timing.reason))return `Waiting for an updated ${field.sources.drive.provider} drive.`;
    if(/timestamps/.test(timing.reason))return 'Clock and drive updates have not aligned yet.';
    return timing.reason;
  }
  if(!sources&&field.sources.clock.freshness==='stale')return 'Waiting for an updated Polymarket scoreboard.';
  if(!sources&&field.sources.drive.freshness==='stale')return `Waiting for an updated ${field.sources.drive.provider} drive.`;
  if(field.freshness==='transition')return 'No active scrimmage down is reported yet. Waiting for the next drive.';
  if(field.issue)return field.issue;
  if(field.freshness!=='fresh')return field.sources.drive.provider==='Not supplied'?'The game feed has not supplied a drive report.':field.sources.drive.reportAgeMs===null?`The ${field.sources.drive.provider} drive report has no verified timestamp.`:'Waiting for a verified down, possession and field position.';
  return isFootballFreshnessReason(savedReason)?savedReason!:null;
}
