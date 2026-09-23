import {forecastMlbPregame,type MlbEloModel,type MlbForecastResult} from './mlb-forecast.ts';
import {array,object,text,normalize} from '../sports-context/shared.ts';
import type {Market} from '../market/types';
import type {SportsContext} from '../sports-context/types';

/** Match the documented US long-side team to official MLB identities. No cross-provider ID assumptions. */
export function forecastInput(model:MlbEloModel,market:Market,context:SportsContext,metadata:unknown,now:number):MlbForecastResult{
  const no=(reason:string):MlbForecastResult=>({status:'unavailable',reason});
  if(market.league!=='MLB')return no('No tested NFL outcome model is available.');
  if(!market.kind.endsWith('full_game_winner')||!context.game||context.slug!==market.slug)return no('A matched full-game winner market is required.');
  const sides=array(object(metadata).marketSides).map(object).filter(side=>side.long===true);
  if(sides.length!==1)return no('The US YES outcome is missing or ambiguous.');
  const side=sides[0],team=object(side.team);
  const name=text(team.name)||text(side.description),abbr=text(team.abbreviation);
  const candidates=[context.game.home,context.game.away].filter(t=>
    (!!name&&normalize(name)===normalize(t.name))||
    (!!abbr&&normalize(abbr)===normalize(t.abbreviation)));
  if(candidates.length!==1)return no('The US YES team could not be matched unambiguously to an MLB team.');
  if(text(team.name)&&normalize(text(team.name))!==normalize(candidates[0].name))return no('The US team name conflicts with the matched MLB identity.');
  return forecastMlbPregame(model,context,{now,yesTeamId:candidates[0].id,marketFamily:'FULL_GAME_WINNER'});
}
