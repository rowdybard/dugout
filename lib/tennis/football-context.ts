import type {FootballAssessment,FootballReport,FootballReportState,TennisMarket,TennisSession} from './types.ts';

export const FOOTBALL_CONTEXT_MAX_AGE_MS=45_000;
export const isFootballMarket=(market:TennisMarket)=>market.league==='NFL'||market.league==='CFB';
const integer=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;
const facts=(report:FootballReport)=>JSON.stringify({...report,reportTime:0,receiptTime:0});

/** Provider report time and discovery receipt time age independently of market quotes. */
export function assessFootballContext(market:TennisMarket,now:number,previous?:FootballReportState):FootballReportState{
  const reportTime=market.contextUpdatedAt,receiptTime=market.observedAt;
  const assessment=(status:FootballAssessment['status'],reason:string):FootballAssessment=>({status,reason,
    reportTime:Number.isFinite(reportTime)?reportTime:null,receiptTime,
    reportAgeMs:reportTime!==null&&Number.isFinite(reportTime)?now-reportTime:null,receiptAgeMs:now-receiptTime});
  const reject=(status:FootballAssessment['status'],reason:string,conflictedAt=previous?.conflictedAt):FootballReportState=>
    ({...previous,assessment:assessment(status,reason),...(conflictedAt!==undefined?{conflictedAt}:{})});
  if(!Number.isFinite(now)||!Number.isFinite(receiptTime)||receiptTime>now||reportTime===null||!Number.isFinite(reportTime)||reportTime>now||reportTime>receiptTime)
    return reject('unknown','Waiting for verified game-report and receipt times. Fresh quotes do not refresh game context.');
  if(previous?.report&&(reportTime<previous.report.reportTime||receiptTime<previous.report.receiptTime))
    return reject('conflicting','An older game report arrived after a newer one. Waiting for consistent context.');
  if(previous?.conflictedAt!==undefined&&reportTime<=previous.conflictedAt)
    return reject('conflicting','Game facts disagreed at the same report time. Waiting for a newer report.');
  const identity=market.footballIdentity,drive=market.football;
  if(!identity?.yesTeamId||!identity.noTeamId||identity.yesTeamId===identity.noTeamId||!drive)
    return reject('unknown','Waiting for explicit team identities and reported football context.');
  const teamIds=[identity.yesTeamId,identity.noTeamId];
  const teamName=(id:string)=>id===identity.yesTeamId?market.yesName:market.noName;
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
  return after.reportTime>before.reportTime&&(before.score!==after.score||before.period!==after.period||before.possessionTeamId!==after.possessionTeamId);
}

/** Existing positions get one explicit legacy snapshot before any new rule update. */
export function normalizePositionExitRules(session:TennisSession):TennisSession{
  return {...session,positions:session.positions.map(position=>position.status==='open'&&!position.exitRules?{...position,
    exitRules:{targetReturn:session.config.targetReturn,stopReturn:session.config.stopReturn,maxHoldMs:session.config.maxHoldMs,source:'legacy-snapshot' as const}}:position)};
}
