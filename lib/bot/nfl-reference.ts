import type {Market} from '../market/types';
import type {SportsContext} from '../sports-context/types';
import {array,object,text,normalize,number} from '../sports-context/shared.ts';
import {espnReferenceId} from '../sports-context/nfl.ts';

const pathFor=(game:string)=>`/v2/sports/football/leagues/nfl/events/${game}/competitions/${game}`;
function providerPath(value:unknown){
  try{const u=new URL(text(object(value).$ref));return ['http:','https:'].includes(u.protocol)&&u.hostname==='sports.core.api.espn.com'&&!u.username&&!u.password&&!u.port?u.pathname:null;}catch{return null;}
}
export function latestNflPlay(raw:unknown){
  const data=object(raw),plays=array(data.items).map(object);
  if(number(data.pageCount)!==1||number(data.count)!==plays.length||!plays.length)return null;
  if(plays.some(p=>!/^\d+$/.test(text(p.sequenceNumber))))return null;
  plays.sort((a,b)=>Number(b.sequenceNumber)-Number(a.sequenceNumber));
  if(plays[1]?.sequenceNumber===plays[0].sequenceNumber)return null;
  return plays[0];
}
/** Follow only the exact latest-play reference we observed, on the fixed ESPN host. */
export function nflProbabilityUrl(plays:unknown,gameId:string){
  const play=latestNflPlay(plays);
  if(!/^\d+$/.test(gameId)||!play||!/^\d+$/.test(text(play.id)))return null;
  const expected=`${pathFor(gameId)}/probabilities/${play.id}`;
  return providerPath(play.probability)===expected?`https://sports.core.api.espn.com${expected}?lang=en&region=us`:null;
}
export function readNflEstimate(context:SportsContext,plays:unknown,probability:unknown,receivedAt:number):{estimate?:SportsContext['winEstimate'];reason?:string}{
  const game=context.game,p=object(probability),play=latestNflPlay(plays);
  const no=(reason:string)=>({reason});
  if(!Number.isFinite(receivedAt)||receivedAt<=0)return no('Invalid source receipt time.');
  if(context.league!=='NFL'||context.status!=='available'||!game||game.state!=='live'||context.replayAt!==undefined)return no('Waiting for a live NFL game.');
  if(!play)return no('Waiting for complete play-by-play.');
  const playTime=Date.parse(text(play.wallclock));
  if(!Number.isFinite(playTime)||playTime>receivedAt||receivedAt-playTime>120000)return no('Waiting for a recent play. No new entries during a stale feed or long break.');
  if([play.homeScore,play.awayScore].some(v=>typeof v!=='number'||!Number.isInteger(v)||v<0)||play.homeScore!==game.home.score||play.awayScore!==game.away.score||`Q${object(play.period).number}`!==game.period)return no('Score and play feeds disagree. Waiting for them to catch up.');
  const base=pathFor(game.id),playId=text(play.id),url=nflProbabilityUrl(plays,game.id);
  if(!url||providerPath(p)!==`${base}/probabilities/${playId}`||providerPath(p.play)!==`${base}/plays/${playId}`||providerPath(p.competition)!==base
    ||text(p.sequenceNumber)!==text(play.sequenceNumber)||espnReferenceId(p.homeTeam,'teams')!==game.home.id||espnReferenceId(p.awayTeam,'teams')!==game.away.id)return no('The win estimate is not linked to the latest verified play.');
  const home=number(p.homeWinPercentage),away=number(p.awayWinPercentage),tie=number(p.tiePercentage);
  if(home===null||away===null||tie===null||[home,away,tie].some(v=>v<0||v>1)||Math.abs(home+away+tie-1)>0.0001)return no('The source win estimate is incomplete.');
  if(tie!==0)return no('The source assigns a tie probability. Tie settlement has not been modeled.');
  // ESPN lastModified was observed future-dated; actual play wallclock bounds age instead.
  return {estimate:{provider:'ESPN',gameId:game.id,playId,playTime,receivedAt,homeProbability:home,awayProbability:away,tieProbability:tie,sourceUrl:url}};
}
export type NflReference={status:'unavailable';reason:string}|{status:'available';modelId:'ESPN_LIVE_REFERENCE';modelVersion:'espn-live-reference-v1';gameId:string;yesTeamId:string;yesProbability:number;homeProbability:number;generatedAt:number;sportsReceivedAt:number;playId:string;playTime:number;playerImpactModeled:false};
export function nflReferenceInput(market:Market,context:SportsContext,metadata:unknown,now:number):NflReference{
  const no=(reason:string):NflReference=>({status:'unavailable',reason});
  const e=context.winEstimate,g=context.game;
  if(!Number.isFinite(now)||!Number.isFinite(context.receivedAt)||context.receivedAt<=0||context.league!=='NFL'||context.status!=='available')return no('Invalid NFL context.');
  if(market.league!=='NFL'||!market.kind.endsWith('full_game_winner')||context.slug!==market.slug||!g||g.state!=='live')return no('NFL entries use live full-game winner markets only.');
  if(!e)return no(context.winEstimateReason??'Waiting for ESPN’s latest play-linked estimate.');
  if(!Number.isFinite(e.receivedAt)||!Number.isFinite(e.playTime)||e.receivedAt<=0||e.playTime<=0||e.gameId!==g.id||context.replayAt!==undefined||e.receivedAt>now||context.receivedAt>now||now-e.receivedAt>45000||now-context.receivedAt>45000||e.playTime>now||now-e.playTime>120000)return no('The play-linked NFL estimate is stale.');
  const sides=array(object(metadata).marketSides).map(object).filter(s=>s.long===true);
  if(sides.length!==1)return no('The US YES team is ambiguous.');
  const team=object(sides[0].team),name=text(team.name)||text(sides[0].description),abbr=text(team.abbreviation);
  const match=[g.home,g.away].filter(t=>(!!name&&normalize(name)===normalize(t.name))||(!!abbr&&normalize(abbr)===normalize(t.abbreviation)));
  if(match.length!==1||(text(team.name)&&normalize(text(team.name))!==normalize(match[0].name)))return no('The US YES team does not match the NFL game.');
  return {status:'available',modelId:'ESPN_LIVE_REFERENCE',modelVersion:'espn-live-reference-v1',gameId:g.id,yesTeamId:match[0].id,yesProbability:match[0].id===g.home.id?e.homeProbability:e.awayProbability,homeProbability:e.homeProbability,generatedAt:now,sportsReceivedAt:context.receivedAt,playId:e.playId,playTime:e.playTime,playerImpactModeled:false};
}
