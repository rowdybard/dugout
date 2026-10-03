import type {TennisMarket} from './types';

/** Keep an observed scoring update visible through drive-report gaps, without changing any evidence clock. */
export function retainFootballScore(market:TennisMarket,previous:TennisMarket|undefined):TennisMarket {
  if(market.footballLastScore?.score===market.score)return market;
  if(!previous||previous.eventId!==market.eventId||previous.slug!==market.slug||!market.footballIdentity||!previous.footballIdentity
    ||market.footballIdentity.yesTeamId!==previous.footballIdentity.yesTeamId||market.footballIdentity.noTeamId!==previous.footballIdentity.noTeamId)return market;
  if(previous.footballLastScore?.score===market.score)return {...market,footballLastScore:previous.footballLastScore};
  const parse=(score:string|null)=>{const match=/^(\d+)\s*-\s*(\d+)$/.exec(score??'');return match?[Number(match[1]),Number(match[2])]:null;};
  const before=parse(previous.score),after=parse(market.score);
  if(!before||!after||market.contextUpdatedAt===null||!Number.isFinite(market.contextUpdatedAt)||market.contextUpdatedAt<0
    ||!Number.isFinite(market.observedAt)||market.contextUpdatedAt>market.observedAt
    ||previous.contextUpdatedAt!==null&&market.contextUpdatedAt<=previous.contextUpdatedAt)return market;
  const delta=after.map((value,index)=>value-before[index]),index=delta.findIndex(value=>value>0);
  if(index<0||delta[1-index]!==0||delta[index]>8||!['away','home'].includes(market.yesOrdering??''))return market;
  const yes=(index===0)===(market.yesOrdering==='away');
  return {...market,footballLastScore:{teamId:yes?market.footballIdentity.yesTeamId:market.footballIdentity.noTeamId,team:yes?market.yesName:market.noName,
    points:delta[index],kind:'score-change',score:market.score!,reportTime:market.contextUpdatedAt,provider:'POLYMARKET'}};
}
