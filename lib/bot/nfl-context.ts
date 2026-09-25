import type {BotInput,BotSession} from './types';
import type {ContextBaseline,EntryVeto} from './entry-analysis';
import {normalize} from '../sports-context/shared.ts';

/** NFL experiment: observed QBs + report changes. No numerical injury effect is invented. */
export function nflContextBlock(s:BotSession,input:BotInput,now:number){
  const c=input.context,g=c.game,old=s.contextBaselines[input.market.gameId];
  if(input.source==='REPLAY'||c.replayAt!==undefined)return 'Recorded data cannot authorize a current entry.';
  if(c.status!=='available')return c.limitations[0]??'Waiting for the NFL sports source.';
  if(c.status!=='available'||!g||g.state!=='live'||c.league!=='NFL'||c.slug!==input.market.slug)return 'Waiting for a matched live NFL game.';
  if(!Number.isFinite(now)||!Number.isFinite(c.receivedAt)||c.receivedAt<=0||c.receivedAt>now||now-c.receivedAt>45000)return 'NFL game context is stale.';
  if(old&&old.gameId!==g.id)return 'The sports game identity changed.';
  if(old&&c.receivedAt<old.receivedAt)return 'Waiting for a newer NFL context snapshot.';
  if(c.injuryStatus!=='source_reports'||!Number.isFinite(c.injuryReceivedAt)||!c.injuryReceivedAt||c.injuryReceivedAt>now||now-c.injuryReceivedAt>180000)return 'Waiting for current source injury reports.';
  if((c.injuries??[]).some(i=>i.reportedAt!==undefined&&i.reportedAt!==null&&(!Number.isFinite(Date.parse(i.reportedAt))||Date.parse(i.reportedAt)>now)))return 'An injury report has an invalid source time.';
  if(c.changes.some(c=>c.sourceEventTime!==undefined&&c.sourceEventTime!==null&&(!Number.isFinite(Date.parse(c.sourceEventTime))||Date.parse(c.sourceEventTime)>now)))return 'A player change has an invalid source time.';
  const playerIds:Record<string,string>={},injuryFacts:Record<string,string>={...(old?.injuryFacts??{})};
  const quarantined:EntryVeto[]=[...(old?.quarantined??[])];
  const flag=(code:string,reason:string,evidenceId:string)=>{if(!quarantined.some(v=>v.evidenceId===evidenceId))quarantined.push({code,reason,evidenceId,knownAt:now});};
  for(const team of [g.home,g.away]){
    const players=c.players.filter(p=>normalize(p.team)===normalize(team.name)&&p.role==='last_observed_passer');
    if(players.length!==1||!players[0].id)return `Waiting for observed quarterback data for ${team.abbreviation}.`;
    const key=normalize(team.name),p=players[0];playerIds[key]=p.id;
    if(old?.playerIds[key]&&old.playerIds[key]!==p.id)flag('QB_CHANGE','Quarterback changed. Waiting for new plays and stable observations.',`${key}:${p.id}:${c.receivedAt}`);
    if(c.injuries?.some(i=>normalize(i.name)===normalize(p.name)&&normalize(i.team)===key&&/^(out|inactive)$/i.test(i.status)))return `The observed quarterback has an out/inactive report. Waiting for consistent availability data.`;
  }
  for(const injury of c.injuries??[]){
    const key=`${normalize(injury.team)}:${normalize(injury.name)}`,fact=`${injury.status}:${injury.reportedAt??'unknown'}`;
    if(old&&old.injuryFacts[key]!==fact)flag('INJURY_CHANGE','An injury report changed. Waiting for later plays before another entry.',`${key}:${fact}`);
    injuryFacts[key]=fact;
  }
  const changes=c.changes.map(change=>change.id);
  for(const change of c.changes){
    const when=change.sourceEventTime?Date.parse(change.sourceEventTime):NaN;
    if((old&&!old.observedChangeIds.includes(change.id))||(!old&&Number.isFinite(when)&&when<=now&&now-when<120000))flag('QB_CHANGE','A different passer was reported. Waiting for subsequent play evidence.',change.id);
  }
  const baseline:ContextBaseline={gameId:g.id,receivedAt:c.receivedAt,independentSnapshots:(old?.independentSnapshots??0)+Number(!old||c.receivedAt>old.receivedAt),playerIds,injuryFacts,observedChangeIds:changes,quarantined};
  s.contextBaselines[input.market.gameId]=baseline;
  const block=quarantined.find(v=>now-v.knownAt<120000||!c.winEstimate||c.winEstimate.playTime<=v.knownAt);
  if(block)return block.reason;
  if(baseline.independentSnapshots<2)return 'Checking another NFL snapshot before the first entry.';
  return null;
}
