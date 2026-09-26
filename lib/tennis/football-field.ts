import type {FootballAssessment,TennisMarket} from '@/lib/tennis/types';

export const FOOTBALL_FIELD_FRESH_MS=45_000;
export type FootballFieldMarket=Pick<TennisMarket,'league'|'yesName'|'noName'|'footballIdentity'|'football'|'observedAt'|'contextUpdatedAt'|'live'|'ended'>;
export type FootballFieldView={
  supported:boolean;lineOfScrimmage:number|null;firstDownLine:number|null;
  possession:'YES'|'NO'|null;direction:1|-1|null;goalToGo:boolean;
  positionLabel:string;possessionLabel:string;distanceLabel:string;
  freshness:'fresh'|'stale'|'unknown'|'conflicting';reportAgeMs:number|null;receiptAgeMs:number|null;
  ageLabel:string;issue:string|null;
};

const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
const ageText=(ms:number)=>ms<60_000?`${Math.floor(ms/1000)}s`:ms<3_600_000?`${Math.floor(ms/60_000)}m ${Math.floor(ms%60_000/1000)}s`:`${Math.floor(ms/3_600_000)}h ${Math.floor(ms%3_600_000/60_000)}m`;

/** Fixed coordinates: YES owns the left goal (0); NO owns the right goal (100).
 * Names never substitute for provider team IDs, and book timestamps are irrelevant.
 */
export function footballFieldView(market:FootballFieldMarket,now:number,assessment?:FootballAssessment):FootballFieldView{
  const report=market.contextUpdatedAt,receipt=market.observedAt;
  const validTime=Number.isFinite(now)&&typeof report==='number'&&Number.isFinite(report)&&report>=0&&report<=now&&Number.isFinite(receipt)&&receipt>=report&&receipt<=now;
  const reportAgeMs=validTime?now-report!:null,receiptAgeMs=validTime?now-receipt:null;
  const clockFreshness=reportAgeMs===null||receiptAgeMs===null?'unknown':reportAgeMs>FOOTBALL_FIELD_FRESH_MS||receiptAgeMs>FOOTBALL_FIELD_FRESH_MS?'stale':'fresh';
  // A retained location can still have recent timestamps after a newer report
  // was rejected. Its assessment must prevent a fresh/solid field claim.
  // A previously fresh assessment can never stop these timestamps from aging.
  const freshness=assessment&&assessment.status!=='fresh'?assessment.status:clockFreshness;
  const assessmentIssue=assessment&&assessment.status!=='fresh'?assessment.reason:null;
  const result:FootballFieldView={supported:market.league==='NFL'||market.league==='CFB',lineOfScrimmage:null,firstDownLine:null,
    possession:null,direction:null,goalToGo:false,positionLabel:'Field position unavailable',possessionLabel:'Possession not verified',distanceLabel:'Down & distance unavailable',
    freshness,reportAgeMs,receiptAgeMs,ageLabel:reportAgeMs===null?'Report time unverified':`Reported ${ageText(reportAgeMs)} ago`,issue:assessmentIssue};
  const unavailable=(issue:string)=>({...result,issue:assessmentIssue?`${assessmentIssue} ${issue}`:issue});
  if(!result.supported)return unavailable('Field view is available for football games.');
  const identity=market.footballIdentity,drive=market.football;
  if(!identity?.yesTeamId?.trim()||!identity.noTeamId?.trim()||identity.yesTeamId===identity.noTeamId||!drive)
    return unavailable('Waiting for verified team identities and a field report.');
  const teamSide=(id:string|undefined|null)=>id===identity.yesTeamId?'YES':id===identity.noTeamId?'NO':null;
  const teamName=(side:'YES'|'NO')=>side==='YES'?market.yesName:market.noName;
  const possession=teamSide(drive.possessionTeamId);
  if(possession&&drive.possessionTeam===teamName(possession)){
    result.possession=possession;result.direction=possession==='YES'?1:-1;
    result.possessionLabel=`${teamName(possession)} has the ball`;
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
