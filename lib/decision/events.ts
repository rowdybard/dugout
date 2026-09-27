/**
 * Game events as data (docs/STRATEGY-ARCHITECTURE.md#events). The feed reports STATES; strategies about reactions
 * need EVENTS: when the score or possession changed, who benefited, and where the price was before the market could
 * have known. Detection is pure and deterministic, from two successive verified game states.
 *
 * Only what the feed actually says is recorded. It does not tell a punt from an interception or a touchdown from a
 * field goal plus extra point, so a score event carries the point change, and a possession change carries no cause.
 */

import type {SideKey} from './context.ts';

export type GameEventType='score'|'possession'|'period'|'dead-ball';
export type GameEvent={
  id:string;type:GameEventType;
  /** Provider report time of the state that revealed the event, and when Dugout received it (epoch ms). */
  reportTime:number;receivedAt:number;
  /** Who scored or gained the ball; null for period and dead-ball events. */
  side:SideKey|null;
  /** Points added by this score (sum across both teams if both changed). */
  points:number;
  score:string;period:string;
  /**
   * YES midpoint before the market could have reacted: the last book at least PRE_EVENT_LOOKBACK_MS before the
   * provider's report time. Null when no such book was seen (the bot joined late).
   */
  preYesMid:number|null;
  /** YES midpoint on the last book before the report reached Dugout: how much the market moved before our feed. */
  atReportYesMid:number|null;
};

/** The market often moves before the feed reports; use prices from before that window as "pre-event". */
export const PRE_EVENT_LOOKBACK_MS=30_000;
/** Events kept per market. */
export const EVENT_TAPE_LIMIT=24;

export type FootballState={reportTime:number;score:string;period:string;possessionTeamId:string|null;deadBall:boolean};

/** Scores read "away-home"; returns points per side, or null if the score or ordering is unknown. */
export function sidePoints(score:string,yesOrdering:'away'|'home'|null|undefined):{yes:number;no:number}|null {
  const match=/^(\d+)\s*-\s*(\d+)$/.exec(score.trim());
  if(!match||(yesOrdering!=='away'&&yesOrdering!=='home'))return null;
  const away=Number(match[1]),home=Number(match[2]);
  return yesOrdering==='away'?{yes:away,no:home}:{yes:home,no:away};
}

/**
 * Events between two successive states of one game. `teams` maps team ids to sides. Returns nothing when `next` is
 * not newer than `previous`, and nothing for the first state seen (no before/after to compare).
 */
export function detectFootballEvents(input:{
  previous:FootballState|undefined;next:FootballState;receivedAt:number;yesOrdering:'away'|'home'|null|undefined;
  teams:{yes:string;no:string};preYesMid:number|null;atReportYesMid:number|null;
}):GameEvent[] {
  const {previous,next}=input;
  if(!previous||next.reportTime<=previous.reportTime)return [];
  const base={reportTime:next.reportTime,receivedAt:input.receivedAt,score:next.score,period:next.period,preYesMid:input.preYesMid,atReportYesMid:input.atReportYesMid};
  const events:GameEvent[]=[];
  const before=sidePoints(previous.score,input.yesOrdering),after=sidePoints(next.score,input.yesOrdering);
  if(before&&after&&(after.yes!==before.yes||after.no!==before.no)){
    const yes=after.yes-before.yes,no=after.no-before.no;
    // A correction that lowers a score is not a scoring play; record nothing rather than guess.
    if(yes>=0&&no>=0)events.push({...base,id:`${next.reportTime}:score`,type:'score',side:yes>0&&no===0?'yes':no>0&&yes===0?'no':null,points:yes+no});
  }
  const holder=(team:string|null)=>team===input.teams.yes?'yes':team===input.teams.no?'no':null;
  const was=holder(previous.possessionTeamId),is=holder(next.possessionTeamId);
  if(was&&is&&was!==is&&!events.length)events.push({...base,id:`${next.reportTime}:possession`,type:'possession',side:is,points:0});
  if(previous.period!==next.period)events.push({...base,id:`${next.reportTime}:period`,type:'period',side:null,points:0});
  if(next.deadBall&&!previous.deadBall)events.push({...base,id:`${next.reportTime}:dead-ball`,type:'dead-ball',side:null,points:0});
  return events;
}

/** The latest event of a type at or before `now`. */
export function latestEvent(events:readonly GameEvent[]|undefined,type:GameEventType,now:number):GameEvent|undefined {
  return [...(events??[])].reverse().find(event=>event.type===type&&event.receivedAt<=now);
}
