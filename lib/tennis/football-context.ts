import type {FootballAssessment,FootballReport,FootballReportState,FootballScoreboard,FootballSources,FootballTransition,TennisMarket,TennisSession} from './types.ts';

export const FOOTBALL_CONTEXT_MAX_AGE_MS=45_000;
export const FOOTBALL_SOURCE_GAP_MS=15_000;
export const isFootballMarket=(market:TennisMarket)=>market.league==='NFL'||market.league==='CFB';
const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
const facts=(report:FootballReport)=>JSON.stringify({...report,reportTime:0,receiptTime:0});

const validClock=(time:number,receipt:number,now:number)=>Number.isFinite(time)&&Number.isFinite(receipt)&&time>=0&&receipt>=0&&time<=receipt&&receipt<=now;
const freshClock=(time:number,receipt:number,now:number)=>validClock(time,receipt,now)&&now-time<=FOOTBALL_CONTEXT_MAX_AGE_MS&&now-receipt<=FOOTBALL_CONTEXT_MAX_AGE_MS;
const scoreboardFacts=(report:FootballScoreboard)=>JSON.stringify([report.eventId,report.yesTeamId,report.noTeamId,report.score,report.period,report.clock]);
const driveFacts=(report:FootballReport|FootballTransition)=>'phase' in report?'between-plays':JSON.stringify([report.possessionTeamId,report.down,report.yardsToGo,report.fieldPosition]);
export const footballDriveVersion=(source:FootballSources['drive'])=>JSON.stringify([source.provider,source.eventId,source.playId??null,source.sequence??null,source.reportTime]);
/** Provider handoffs invalidate a setup; ordinary timestamp/clock updates do not. */
export function footballSourceChanged(before:FootballReport|FootballTransition|undefined,after:FootballReport|FootballTransition|undefined):boolean{
  if(!before||!after)return false;
  const a=before.sources?.drive,b=after.sources?.drive;
  return (a?.provider??'POLYMARKET')!==(b?.provider??'POLYMARKET')||(a?.eventId??before.eventId)!==(b?.eventId??after.eventId)
    ||JSON.stringify(before.sources?.mapping??null)!==JSON.stringify(after.sources?.mapping??null);
}

/** PM scoreboard facts remain usable for exits even when ESPN cannot supply a coherent drive. */
export function verifiedFootballScoreboard(market:TennisMarket,now:number):FootballScoreboard|undefined{
  const identity=market.footballIdentity,source=market.footballSources?.scoreboard;
  const reportTime=source?.reportTime??market.contextUpdatedAt,receiptTime=source?.receiptTime??market.observedAt;
  if(!identity?.yesTeamId||!identity.noTeamId||identity.yesTeamId===identity.noTeamId||reportTime===null
    ||!freshClock(reportTime,receiptTime,now)||source&&(source.provider!=='POLYMARKET'||source.eventId!==market.eventId||source.reportTime!==market.contextUpdatedAt)
    ||!market.score||!/^\d+\s*-\s*\d+$/.test(market.score)||!market.period||!/^(Q[1-4]|OT\d*|\d+OT|HT|FT|FINAL|END(?:\s+Q[1-4])?)$/i.test(market.period))return undefined;
  return {eventId:market.eventId,yesTeamId:identity.yesTeamId,noTeamId:identity.noTeamId,reportTime,receiptTime,score:market.score,period:market.period,clock:market.clock??''};
}

function assessSourcedFootball(market:TennisMarket,now:number,previous?:FootballReportState):FootballReportState{
  const sources=market.footballSources,identity=market.footballIdentity,drive=market.football;
  const pm=sources?.scoreboard,ds=sources?.drive;
  const reportTime=sources?Math.min(pm?.reportTime??NaN,ds?.reportTime??NaN):market.contextUpdatedAt;
  const receiptTime=sources?Math.min(pm?.receiptTime??NaN,ds?.receiptTime??NaN):market.observedAt;
  const assessment=(status:FootballAssessment['status'],reason:string):FootballAssessment=>({status,reason,reportTime:reportTime!==null&&Number.isFinite(reportTime)?reportTime:null,receiptTime,
    reportAgeMs:reportTime!==null&&Number.isFinite(reportTime)?now-reportTime:null,receiptAgeMs:now-receiptTime});
  const base:FootballReportState={...previous,assessment:assessment('unknown','Waiting for coherent football sources.')};
  const reject=(status:FootballAssessment['status'],reason:string,component?:'scoreboard'|'drive')=>{
    if(component&&pm&&ds)base.sourceConflict={scoreboardTime:pm.reportTime,driveTime:ds.reportTime,driveProvider:ds.provider,playId:ds.playId,sequence:ds.sequence,component};
    return {...base,assessment:assessment(status,reason)};
  };
  const previousReport=previous?.transition??previous?.report;
  const oldScoreboard=previous?.scoreboard??previousReport;
  const scoreboard=verifiedFootballScoreboard(market,now);
  if(scoreboard){
    if(oldScoreboard&&(scoreboard.eventId!==oldScoreboard.eventId||scoreboard.yesTeamId!==oldScoreboard.yesTeamId||scoreboard.noTeamId!==oldScoreboard.noTeamId))return reject('conflicting','The scoreboard game or team mapping changed.');
    if(oldScoreboard&&(scoreboard.reportTime<oldScoreboard.reportTime||scoreboard.receiptTime<oldScoreboard.receiptTime))return reject('conflicting','An older Polymarket scoreboard arrived after a newer one.');
    if(oldScoreboard&&scoreboard.reportTime===oldScoreboard.reportTime&&scoreboardFacts(scoreboard)!==scoreboardFacts(oldScoreboard))return reject('conflicting','Polymarket scoreboard facts changed at the same source timestamp.','scoreboard');
    if(previous?.sourceConflict?.component==='scoreboard'&&scoreboard.reportTime<=previous.sourceConflict.scoreboardTime)return reject('conflicting','Waiting for a newer Polymarket scoreboard after conflicting facts.');
    base.scoreboard=scoreboard;
  }
  if(!scoreboard)return reject(pm&&validClock(pm.reportTime,pm.receiptTime,now)&&!freshClock(pm.reportTime,pm.receiptTime,now)?'stale':'unknown','Waiting for a fresh verified Polymarket scoreboard.');
  if(market.footballSourceIssue)return reject('unknown',market.footballSourceIssue);
  if(!sources||!ds||!pm)return reject('unknown','Waiting for independently timestamped drive details.');
  if(!validClock(ds.reportTime,ds.receiptTime,now)||!validClock(pm.reportTime,pm.receiptTime,now))return reject('unknown','Football source report and receipt times are invalid or in the future.');
  if(!freshClock(ds.reportTime,ds.receiptTime,now)||!freshClock(pm.reportTime,pm.receiptTime,now))return reject('stale','One football source is older than 45 seconds.');
  if(Math.abs(pm.reportTime-ds.reportTime)>FOOTBALL_SOURCE_GAP_MS)return reject('unknown','The scoreboard and drive source timestamps are more than 15 seconds apart.');
  if(ds.sequence!==undefined&&!integer(ds.sequence,0,Number.MAX_SAFE_INTEGER))return reject('unknown','The drive source sequence is invalid.');
  if(ds.provider==='ESPN'){
    const mapping=sources.mapping;
    if(!mapping||mapping.yesPolymarketTeamId!==identity?.yesTeamId||mapping.noPolymarketTeamId!==identity?.noTeamId||!mapping.yesEspnTeamId||!mapping.noEspnTeamId||mapping.yesEspnTeamId===mapping.noEspnTeamId||!ds.eventId||!ds.playId)
      return reject('unknown','Waiting for verified ESPN event, play and outcome team mapping.');
    if(ds.score!==market.score||ds.period!==market.period)return reject('unknown','ESPN drive details do not match the Polymarket score and quarter.');
  }else if(ds.provider!=='POLYMARKET'||ds.eventId!==market.eventId)return reject('unknown','The drive source does not match this Polymarket event.');
  const frontier=previous?.transition??previous?.report,oldDrive=frontier?.sources?.drive;
  const sameSource=oldDrive?.provider===ds.provider&&oldDrive.eventId===ds.eventId;
  if(sameSource&&(ds.reportTime<oldDrive!.reportTime||ds.receiptTime<oldDrive!.receiptTime||ds.sequence!==undefined&&oldDrive!.sequence!==undefined&&ds.sequence<oldDrive!.sequence))
    return reject('conflicting','An older drive report arrived after a newer one.');
  const conflict=previous?.sourceConflict;
  if(conflict?.component==='drive'&&conflict.driveProvider===ds.provider&&ds.reportTime<=conflict.driveTime&&ds.playId===conflict.playId&&ds.sequence===conflict.sequence)
    return reject('conflicting','Waiting for a newer drive source version after conflicting facts.');
  if(!drive||!identity)return reject('unknown','Waiting for reported possession, down, distance and field position.');
  const scoreboardComplete=/^(Q[1-4]|OT\d*|\d+OT)$/.test(scoreboard.period)&&/^\d{1,2}:[0-5]\d$/.test(scoreboard.clock);
  let report:FootballReport|FootballTransition;
  if(drive.phase==='between-plays'&&scoreboardComplete&&ds.provider==='POLYMARKET')report={...scoreboard,reportTime:reportTime!,receiptTime,phase:'between-plays',sources:structuredClone(sources)};
  else{
    const teams=[identity.yesTeamId,identity.noTeamId],name=(id:string)=>id===identity.yesTeamId?market.yesName:market.noName,field=drive.fieldPosition;
    if(!scoreboardComplete||!drive.possessionTeamId||!teams.includes(drive.possessionTeamId)||drive.possessionTeam!==name(drive.possessionTeamId)||!integer(drive.down,1,4)||!integer(drive.yardsToGo,0,100)
      ||!field?.teamId||!teams.includes(field.teamId)||field.team!==name(field.teamId)||!integer(field.yard,0,50))return reject('unknown','Waiting for complete, coherent football drive details.');
    report={...scoreboard,reportTime:reportTime!,receiptTime,possessionTeamId:drive.possessionTeamId,down:drive.down,yardsToGo:drive.yardsToGo,fieldPosition:{teamId:field.teamId,yard:field.yard},sources:structuredClone(sources)};
  }
  if(sameSource&&frontier&&footballDriveVersion(oldDrive!)===footballDriveVersion(ds)&&driveFacts(frontier)!==driveFacts(report))return reject('conflicting','Drive facts changed at the same source version.','drive');
  if(sameSource&&oldDrive&&ds.reportTime===oldDrive.reportTime&&ds.playId!==oldDrive.playId&&!(ds.sequence!==undefined&&oldDrive.sequence!==undefined&&ds.sequence>oldDrive.sequence))
    return reject('conflicting','The new play has no verifiable ordering at the same timestamp.');
  const changed=footballSourceChanged(frontier,report);
  return {...('phase' in report?{transition:report}:{report}),scoreboard,
    ...(changed?{sourceChangedAt:now}:previous?.sourceChangedAt!==undefined?{sourceChangedAt:previous.sourceChangedAt}:{}),
    assessment:assessment('phase' in report?'transition':'fresh','phase' in report?'Verified Polymarket between-plays report.':'Fresh verified scoreboard and drive sources.')};
}

/** Provider report time and discovery receipt time age independently of market quotes. */
export function assessFootballContext(market:TennisMarket,now:number,previous?:FootballReportState):FootballReportState{
  if(market.footballSources||market.footballSourceIssue)return assessSourcedFootball(market,now,previous);
  const reportTime=market.contextUpdatedAt,receiptTime=market.observedAt;
  const assessment=(status:FootballAssessment['status'],reason:string):FootballAssessment=>({status,reason,
    reportTime:Number.isFinite(reportTime)?reportTime:null,receiptTime,
    reportAgeMs:reportTime!==null&&Number.isFinite(reportTime)?now-reportTime:null,receiptAgeMs:now-receiptTime});
  const reject=(status:FootballAssessment['status'],reason:string,conflictedAt=previous?.conflictedAt):FootballReportState=>
    ({...previous,assessment:assessment(status,reason),...(conflictedAt!==undefined?{conflictedAt}:{})});
  if(!Number.isFinite(now)||!Number.isFinite(receiptTime)||receiptTime>now||reportTime===null||!Number.isFinite(reportTime)||reportTime>now||reportTime>receiptTime)
    return reject('unknown','Waiting for verified game-report and receipt times. Fresh quotes do not refresh game context.');
  const frontier=previous?.transition??previous?.report;
  if(frontier&&(reportTime<frontier.reportTime||receiptTime<frontier.receiptTime))
    return reject('conflicting','An older game report arrived after a newer one. Waiting for consistent context.');
  if(previous?.conflictedAt!==undefined&&reportTime<=previous.conflictedAt)
    return reject('conflicting','Game facts disagreed at the same report time. Waiting for a newer report.');
  const identity=market.footballIdentity,drive=market.football;
  if(!identity?.yesTeamId||!identity.noTeamId||identity.yesTeamId===identity.noTeamId||!drive)
    return reject('unknown','Waiting for explicit team identities and reported football context.');
  const teamIds=[identity.yesTeamId,identity.noTeamId];
  const teamName=(id:string)=>id===identity.yesTeamId?market.yesName:market.noName;
  if(frontier&&(frontier.eventId!==market.eventId||frontier.yesTeamId!==identity.yesTeamId||frontier.noTeamId!==identity.noTeamId))
    return reject('conflicting','The game or outcome team mapping changed. New entries are blocked.');
  const scoreboard=!!market.score&&/^\d+\s*-\s*\d+$/.test(market.score)&&!!market.period&&/^(Q[1-4]|OT\d*|\d+OT)$/.test(market.period)&&!!market.clock&&/^\d{1,2}:[0-5]\d$/.test(market.clock);
  if(frontier?.reportTime===reportTime&&(frontier.score!==market.score||frontier.period!==market.period||frontier.clock!==market.clock||!!previous?.transition!==(drive.phase==='between-plays')))
    return reject('conflicting','Game facts disagreed at the same report time. Waiting for a newer report.',reportTime);
  if(drive.phase==='between-plays'&&scoreboard){
    const stale=now-reportTime>FOOTBALL_CONTEXT_MAX_AGE_MS||now-receiptTime>FOOTBALL_CONTEXT_MAX_AGE_MS;
    const transition={eventId:market.eventId,yesTeamId:identity.yesTeamId,noTeamId:identity.noTeamId,reportTime,receiptTime,
      score:market.score!,period:market.period!,clock:market.clock!,phase:'between-plays' as const};
    return {...previous,transition,assessment:assessment(stale?'stale':'transition',stale?
      'The between-plays report is older than 45 seconds. Waiting for a newer game report.':
      `Score ${market.score}. Between scrimmage plays; waiting for the next verified down. Kick or scoring-play type is not supplied by this feed.`)};
  }
  if(!drive.possessionTeamId||!teamIds.includes(drive.possessionTeamId)||drive.possessionTeam!==teamName(drive.possessionTeamId))
    return reject('unknown','Reported possession does not match the verified teams.');
  const field=drive.fieldPosition;
  if(!integer(drive.down,1,4)||!integer(drive.yardsToGo,0,100)||!field?.teamId||!teamIds.includes(field.teamId)||field.team!==teamName(field.teamId)||!integer(field.yard,0,50)||
    !market.score||!/^\d+\s*-\s*\d+$/.test(market.score)||!market.period||!/^(Q[1-4]|OT\d*|\d+OT)$/.test(market.period)||!market.clock||!/^\d{1,2}:[0-5]\d$/.test(market.clock))
    return reject('unknown','Waiting for a complete score, quarter, clock, possession, down, distance and field report.');
  const report:FootballReport={eventId:market.eventId,yesTeamId:identity.yesTeamId,noTeamId:identity.noTeamId,reportTime,receiptTime,
    score:market.score,period:market.period,clock:market.clock,possessionTeamId:drive.possessionTeamId,
    down:drive.down,yardsToGo:drive.yardsToGo,fieldPosition:{teamId:field.teamId,yard:field.yard}};
  if(previous?.report&&(previous.report.eventId!==report.eventId||previous.report.yesTeamId!==report.yesTeamId||previous.report.noTeamId!==report.noTeamId))
    return reject('conflicting','The game or outcome team mapping changed. New entries are blocked.');
  if(previous?.report?.reportTime===reportTime&&facts(previous.report)!==facts(report))
    return reject('conflicting','Game facts disagreed at the same report time. Waiting for a newer report.',reportTime);
  const stale=now-reportTime>FOOTBALL_CONTEXT_MAX_AGE_MS||now-receiptTime>FOOTBALL_CONTEXT_MAX_AGE_MS;
  return {report,assessment:assessment(stale?'stale':'fresh',stale?'The football report is older than 45 seconds. Waiting for fresh context.':'Fresh verified football context. This is a quality check, not an outcome prediction.')};
}

export function footballBoundaryChanged(before:FootballReport,after:FootballReport):boolean{
  if(before.sources||after.sources)return (after.reportTime>=before.reportTime||footballSourceChanged(before,after))&&(before.score!==after.score||before.period!==after.period||before.possessionTeamId!==after.possessionTeamId);
  return after.reportTime>before.reportTime&&(before.score!==after.score||before.period!==after.period||before.possessionTeamId!==after.possessionTeamId);
}

/** Existing positions get one explicit legacy snapshot before any new rule update. */
export function normalizePositionExitRules(session:TennisSession):TennisSession{
  return {...session,positions:session.positions.map(position=>position.status==='open'&&!position.exitRules?{...position,
    exitRules:{targetReturn:session.config.targetReturn,stopReturn:session.config.stopReturn,maxHoldMs:session.config.maxHoldMs,source:'legacy-snapshot' as const}}:position)};
}
