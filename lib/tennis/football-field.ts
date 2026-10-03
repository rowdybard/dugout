import type {FootballAssessment,TennisMarket} from '@/lib/tennis/types';

export const FOOTBALL_FIELD_FRESH_MS=45_000;
export type FootballFieldMarket=Pick<TennisMarket,'league'|'yesName'|'noName'|'footballIdentity'|'football'|'footballSources'|'footballSourceIssue'|'observedAt'|'contextUpdatedAt'|'live'|'ended'>;
export type FootballSourceAge={provider:string;reportAgeMs:number|null;receiptAgeMs:number|null;freshness:'fresh'|'stale'|'unknown';label:string};
export type FootballSourceView={label:string;clock:FootballSourceAge;drive:FootballSourceAge};
export type FootballFieldView={
  supported:boolean;lineOfScrimmage:number|null;firstDownLine:number|null;
  possession:'YES'|'NO'|null;direction:1|-1|null;goalToGo:boolean;
  positionLabel:string;possessionLabel:string;distanceLabel:string;
  freshness:'fresh'|'stale'|'unknown'|'conflicting'|'transition';reportAgeMs:number|null;receiptAgeMs:number|null;
  ageLabel:string;issue:string|null;
  sources:FootballSourceView;
};

const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
const ageText=(ms:number)=>ms<60_000?`${Math.floor(ms/1000)}s`:ms<3_600_000?`${Math.floor(ms/60_000)}m ${Math.floor(ms%60_000/1000)}s`:`${Math.floor(ms/3_600_000)}h ${Math.floor(ms%3_600_000/60_000)}m`;

/** A recent source check never changes the age of the facts it returned. */
export function footballSourceView(market:FootballFieldMarket,now:number):FootballSourceView{
  const sourceAge=(provider:string,report:number|null,receipt:number,label:string):FootballSourceAge=>{
    const reportValid=typeof report==='number'&&Number.isFinite(report)&&report>=0&&report<=now;
    const receiptValid=Number.isFinite(receipt)&&receipt>=0&&receipt<=now;
    const ordered=reportValid&&receiptValid&&report!<=receipt;
    const reportAgeMs=reportValid?now-report!:null,receiptAgeMs=receiptValid?now-receipt:null;
    const freshness=!ordered?'unknown':reportAgeMs!>FOOTBALL_FIELD_FRESH_MS||receiptAgeMs!>FOOTBALL_FIELD_FRESH_MS?'stale':'fresh';
    return {provider,reportAgeMs,receiptAgeMs,freshness,
      label:`${label}: ${reportAgeMs===null?'report time unverified':`reported ${ageText(reportAgeMs)} ago`} · ${receiptAgeMs===null?'receipt time unverified':`received ${ageText(receiptAgeMs)} ago`}`};
  };
  const sources=market.footballSources;
  const clock=sourceAge('Polymarket',sources?sources.scoreboard.reportTime:market.contextUpdatedAt,sources?sources.scoreboard.receiptTime:market.observedAt,'Clock');
  const driveProvider=sources?.drive.provider==='ESPN'?'ESPN':market.football||sources?'Polymarket':'Not supplied';
  const drive=sourceAge(driveProvider,sources?sources.drive.reportTime:market.football?market.contextUpdatedAt:null,sources?sources.drive.receiptTime:market.football?market.observedAt:NaN,'Drive');
  return {label:`Clock: ${clock.provider} · Drive: ${drive.provider}`,clock,drive};
}

/** Fixed coordinates: YES owns the left goal (0); NO owns the right goal (100).
 * Names never substitute for provider team IDs, and book timestamps are irrelevant.
 */
export function footballFieldView(market:FootballFieldMarket,now:number,assessment?:FootballAssessment):FootballFieldView{
  const sources=footballSourceView(market,now);
  const report=market.footballSources?market.footballSources.drive.reportTime:market.contextUpdatedAt,receipt=market.footballSources?market.footballSources.drive.receiptTime:market.observedAt;
  const validTime=Number.isFinite(now)&&typeof report==='number'&&Number.isFinite(report)&&report>=0&&report<=now&&Number.isFinite(receipt)&&receipt>=report&&receipt<=now;
  const reportAgeMs=validTime?now-report!:null,receiptAgeMs=validTime?now-receipt:null;
  const clockFreshness=reportAgeMs===null||receiptAgeMs===null?'unknown':reportAgeMs>FOOTBALL_FIELD_FRESH_MS||receiptAgeMs>FOOTBALL_FIELD_FRESH_MS?'stale':'fresh';
  const sourceFreshness=market.footballSources?sources.clock.freshness==='unknown'||sources.drive.freshness==='unknown'?'unknown':sources.clock.freshness==='stale'||sources.drive.freshness==='stale'?'stale':'fresh':clockFreshness;
  // A retained location can still have recent timestamps after a newer report
  // was rejected. Its assessment must prevent a fresh/solid field claim.
  // A previously fresh assessment can never stop these timestamps from aging.
  const freshness=assessment?.status==='transition'&&sourceFreshness!=='fresh'?sourceFreshness:assessment&&assessment.status!=='fresh'?assessment.status:market.footballSourceIssue?'unknown':sourceFreshness;
  const assessmentIssue=market.footballSourceIssue??(assessment&&assessment.status!=='fresh'?assessment.reason:null);
  const result:FootballFieldView={supported:market.league==='NFL'||market.league==='CFB',lineOfScrimmage:null,firstDownLine:null,
    possession:null,direction:null,goalToGo:false,positionLabel:'Field position unavailable',possessionLabel:'Possession not verified',distanceLabel:'Down & distance unavailable',
    freshness,reportAgeMs,receiptAgeMs,ageLabel:reportAgeMs===null?'Report time unverified':`Reported ${ageText(reportAgeMs)} ago`,issue:assessmentIssue,sources};
  const unavailable=(issue:string)=>({...result,freshness:result.freshness==='fresh'?'unknown' as const:result.freshness,issue:assessmentIssue?`${assessmentIssue} ${issue}`:issue});
  if(!result.supported)return unavailable('Field view is available for football games.');
  const identity=market.footballIdentity,drive=market.football;
  if(!identity?.yesTeamId?.trim()||!identity.noTeamId?.trim()||identity.yesTeamId===identity.noTeamId||!drive)
    return unavailable('Waiting for verified team identities and a field report.');
  if(drive.phase==='between-plays')return {...result,distanceLabel:'Between scrimmage plays',possessionLabel:'Next possession awaiting confirmation',
    issue:assessmentIssue??'The feed reports no active scrimmage down. Kick or scoring-play type is not supplied; field lines stay hidden until the next verified down.'};
  const teamSide=(id:string|undefined|null)=>id===identity.yesTeamId?'YES':id===identity.noTeamId?'NO':null;
  const teamName=(side:'YES'|'NO')=>side==='YES'?market.yesName:market.noName;
  const possession=teamSide(drive.possessionTeamId);
  if(possession&&drive.possessionTeam===teamName(possession)){
    result.possession=possession;result.direction=possession==='YES'?1:-1;
    result.possessionLabel=freshness==='fresh'?`${teamName(possession)} has the ball`:`Last reported possession: ${teamName(possession)}`;
  }
  const field=drive.fieldPosition,fieldSide=teamSide(field?.teamId);
  if(!field||!fieldSide||field.team!==teamName(fieldSide)||!integer(field.yard,0,50))
    return unavailable('Waiting for a field position matched to these teams.');
  result.lineOfScrimmage=fieldSide==='YES'?field.yard:100-field.yard;
  result.positionLabel=field.yard===50?'Midfield':`${teamName(fieldSide)} ${field.yard}-yard line`;
  if(result.direction===null)return unavailable('Possession is unverified, so the first-down line is hidden.');
  if(!integer(drive.down,1,4)||!integer(drive.yardsToGo,0,100))
    return unavailable('Waiting for down and distance to draw the first-down line.');
  const target=result.lineOfScrimmage+result.direction*drive.yardsToGo;
  result.firstDownLine=Math.min(100,Math.max(0,target));
  result.goalToGo=result.direction===1?target>=100:target<=0;
  result.distanceLabel=`${['','1st','2nd','3rd','4th'][drive.down]} & ${result.goalToGo?'goal':drive.yardsToGo}`;
  return result;
}
