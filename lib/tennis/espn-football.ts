import type {FootballContext,TennisMarket} from './types';

type Side={polymarketTeamId:string;espnTeamId:string;name:string;homeAway:'home'|'away'};
export type EspnFootballMapping={eventId:string;polymarketEventId:string;kickoffAt:number;yes:Side;no:Side};
export type EspnFootballReport={
  status:'drive'|'transition'|'unavailable';reason:string|null;score:string|null;period:string|null;football:FootballContext|null;
  provenance:{eventId:string;driveId:string|null;playId:string|null;sequence:number|null;reportTime:number|null;playWallclock:number|null;metaUpdatedAt:number|null;receivedAt:number};
};

// Verified public event and team identities on October 3, 2026. No fuzzy title matching.
const GAME={eventId:'401868094',polymarketEventId:'117784',eventSlug:'cfb-monst-idaho-2026-10-02',
  marketSlug:'aec-cfb-monst-idaho-2026-10-02',kickoffAt:Date.parse('2026-10-03T02:30:00Z'),
  away:{polymarketTeamId:'1110',espnTeamId:'147',name:'Montana State',homeAway:'away' as const},
  home:{polymarketTeamId:'1109',espnTeamId:'70',name:'Idaho',homeAway:'home' as const}};
type Raw=Record<string,unknown>;
const object=(value:unknown):Raw=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Raw:{};
const list=(value:unknown):Raw[]=>Array.isArray(value)?value.map(object):[];
const id=(value:unknown):string|null=>(typeof value==='string'||typeof value==='number')&&/^[1-9]\d{0,29}$/.test(String(value))?String(value):null;
const integer=(value:unknown,min:number,max:number):number|null=>{
  if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))return null;
  const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:null;
};
const timestamp=(value:unknown):number|null=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/.test(value))return null;
  const parsed=Date.parse(value);return Number.isFinite(parsed)&&parsed>=0?parsed:null;
};
const sameSide=(a:Side,b:Side)=>a.polymarketTeamId===b.polymarketTeamId&&a.espnTeamId===b.espnTeamId&&a.name===b.name&&a.homeAway===b.homeAway;
const verifiedMapping=(mapping:EspnFootballMapping)=>mapping.eventId===GAME.eventId&&mapping.polymarketEventId===GAME.polymarketEventId&&mapping.kickoffAt===GAME.kickoffAt&&
  (sameSide(mapping.yes,GAME.away)&&sameSide(mapping.no,GAME.home)||sameSide(mapping.yes,GAME.home)&&sameSide(mapping.no,GAME.away));

/** Only the reviewed game qualifies. The outcome ordering may be away/home or home/away. */
export function espnFootballMapping(market:TennisMarket):EspnFootballMapping|null {
  if(market.league!=='CFB'||market.eventId!==GAME.polymarketEventId||market.eventSlug!==GAME.eventSlug||market.slug!==GAME.marketSlug||timestamp(market.startTime)!==GAME.kickoffAt)return null;
  const yes=[GAME.away,GAME.home].find(side=>side.polymarketTeamId===market.footballIdentity?.yesTeamId&&side.name===market.yesName);
  const no=[GAME.away,GAME.home].find(side=>side.polymarketTeamId===market.footballIdentity?.noTeamId&&side.name===market.noName);
  if(!yes||!no||yes===no||market.yesOrdering!==yes.homeAway)return null;
  return {eventId:GAME.eventId,polymarketEventId:GAME.polymarketEventId,kickoffAt:GAME.kickoffAt,yes:{...yes},no:{...no}};
}

/** One ESPN payload supplies the drive, scores and period. Its game clock is intentionally unused. */
export function normalizeEspnFootballReport(raw:unknown,mapping:EspnFootballMapping,receivedAt:number):EspnFootballReport {
  const root=object(raw),header=object(root.header),competitions=list(header.competitions),competition=competitions[0];
  const current=object(object(root.drives).current),plays=list(current.plays),play=plays.at(-1)??{},meta=object(root.meta);
  const playWallclock=timestamp(play.wallclock),metaUpdatedAt=timestamp(meta.lastUpdatedAt);
  const reportTime=playWallclock!==null&&metaUpdatedAt!==null?Math.min(playWallclock,metaUpdatedAt):null;
  const provenance={eventId:mapping.eventId,driveId:id(current.id),playId:id(play.id),sequence:integer(play.sequenceNumber,0,Number.MAX_SAFE_INTEGER),reportTime,playWallclock,metaUpdatedAt,receivedAt};
  let score:string|null=null,period:string|null=null;
  const reject=(reason:string,status:EspnFootballReport['status']='unavailable'):EspnFootballReport=>({status,reason,score,period,football:null,provenance});
  if(!verifiedMapping(mapping)||id(header.id)!==mapping.eventId||competitions.length!==1||id(competition?.id)!==mapping.eventId||timestamp(competition?.date)!==mapping.kickoffAt)return reject('ESPN did not match the verified game and kickoff.');
  const teams=list(competition.competitors);
  if(teams.length!==2||[mapping.yes,mapping.no].some(side=>teams.filter(team=>id(team.id)===side.espnTeamId&&id(object(team.team).id)===side.espnTeamId&&team.homeAway===side.homeAway).length!==1))return reject('ESPN team identities or home/away ordering did not match.');
  const status=object(competition.status),state=object(status.type),quarter=integer(status.period,1,20);
  if(state.state!=='in'||state.completed===true||quarter===null)return reject('ESPN has no live game period.');
  period=quarter<=4?'Q'+quarter:quarter===5?'OT':'OT'+(quarter-4);
  const away=teams.find(team=>team.homeAway==='away')!,home=teams.find(team=>team.homeAway==='home')!;
  const awayScore=integer(away.score,0,200),homeScore=integer(home.score,0,200);
  if(awayScore===null||homeScore===null)return reject('ESPN has no complete score.');
  score=awayScore+'-'+homeScore;
  if(!Number.isFinite(receivedAt)||receivedAt<0||reportTime===null||playWallclock!>receivedAt||metaUpdatedAt!>receivedAt||timestamp(meta.lastPlayWallClock)!==playWallclock)return reject('ESPN play and report timestamps could not be verified.');
  let previousSequence=-1;
  const playIds=new Set<string>();
  const ordered=plays.every(p=>{
    const playId=id(p.id),sequence=integer(p.sequenceNumber,0,Number.MAX_SAFE_INTEGER);
    if(!playId||playIds.has(playId)||sequence===null||sequence<=previousSequence)return false;
    playIds.add(playId);previousSequence=sequence;return true;
  });
  if(!provenance.driveId||!provenance.playId||provenance.sequence===null||!plays.length||!ordered)return reject('ESPN did not identify an ordered latest play in the current drive.');
  if(integer(object(play.period).number,1,20)!==quarter||integer(play.awayScore,0,200)!==awayScore||integer(play.homeScore,0,200)!==homeScore)return reject('ESPN latest play disagreed with its score or period.');
  const type=object(play.type),text=typeof play.text==='string'?play.text:'',kind=typeof type.text==='string'?type.text:'';
  // Special plays and explicit score/possession transitions never become a tradable scrimmage down.
  if(typeof current.result==='string'&&current.result.trim()||current.end!==undefined&&current.end!==null||play.scoringPlay===true||play.isTurnover===true||play.isPenalty===true||integer(play.scoreValue,0,20)!==0||/kick|punt|touchdown|field goal|extra point|conversion|intercept|fumble|turnover|penalty|timeout|end of|two.minute/i.test(kind+' '+text))return reject('ESPN reports a special play or transition; waiting for a verified scrimmage down.','transition');
  if(play.scoringPlay!==false||!['Rush','Pass Reception','Pass Incompletion','Sack'].includes(kind))return reject('ESPN latest play is not a verified ordinary scrimmage play.');
  const end=object(play.end),start=object(play.start),possession=id(end.team&&object(end.team).id),driveTeam=id(object(current.team).id);
  if(!possession||possession!==driveTeam||id(object(start.team).id)!==possession)return reject('ESPN reports a possession transition; waiting for the next verified down.','transition');
  const side=[mapping.yes,mapping.no].find(value=>value.espnTeamId===possession);
  const startingDown=integer(start.down,1,4),down=integer(end.down,1,4),distance=integer(end.distance,0,100),yardsToEndzone=integer(end.yardsToEndzone,0,100),yardLine=integer(end.yardLine,0,100);
  if(!side||startingDown===null||down===null||distance===null||yardsToEndzone===null||yardLine===null)return reject('ESPN has no complete resulting down, distance and field position.');
  if(startingDown===4&&down!==1)return reject('ESPN reports a possible turnover on downs; waiting for the next verified down.','transition');
  if(yardsToEndzone===0||yardsToEndzone===100)return reject('ESPN reports an end-zone transition; waiting for the next verified down.','transition');
  // ESPN yardLine uses a fixed home coordinate. yardsToEndzone is possession-relative.
  const expectedYardLine=side.homeAway==='home'?100-yardsToEndzone:yardsToEndzone;
  if(yardLine!==expectedYardLine)return reject('ESPN field coordinates disagreed.');
  const territory=yardsToEndzone>=50?side:[mapping.yes,mapping.no].find(value=>value!==side)!;
  const yard=yardsToEndzone>=50?100-yardsToEndzone:yardsToEndzone;
  const football:FootballContext={possessionTeam:side.name,possessionTeamId:side.polymarketTeamId,down,yardsToGo:distance,
    fieldPosition:{team:territory.name,teamId:territory.polymarketTeamId,yard},timeouts:[]};
  return {status:'drive',reason:null,score,period,football,provenance};
}
