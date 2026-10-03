import type {TennisMarket} from './types';

/** Reuse verified live context without making held-position exits wait on discovery. */
export function currentTennisContext(stored:TennisMarket,latest:TennisMarket|null|undefined,now:number,exchangeActive=stored.active):TennisMarket {
  if(!latest||now-latest.observedAt>45_000)return stored;
  return retainedTennisContext(stored,latest,now,exchangeActive);
}

/** Keep previously accepted facts through a cache miss, without advancing their age. */
export function retainedTennisContext(stored:TennisMarket,latest:TennisMarket|null|undefined,now:number,exchangeActive=stored.active):TennisMarket {
  const oldDrive=stored.footballSources?.drive,newDrive=latest?.footballSources?.drive;
  const newerDrive=!!newDrive&&Number.isFinite(newDrive.reportTime)&&newDrive.reportTime>=0&&Number.isFinite(newDrive.receiptTime)&&newDrive.reportTime<=newDrive.receiptTime&&newDrive.receiptTime<=now&&
    (!oldDrive||oldDrive.provider!==newDrive.provider||oldDrive.eventId!==newDrive.eventId||newDrive.receiptTime>=oldDrive.receiptTime&&
      (newDrive.reportTime>oldDrive.reportTime||newDrive.reportTime===oldDrive.reportTime&&typeof newDrive.sequence==='number'&&typeof oldDrive.sequence==='number'&&newDrive.sequence>oldDrive.sequence));
  const sourceIssueChanged=latest?.footballSourceIssue!==stored.footballSourceIssue;
  if(!latest||latest.slug!==stored.slug||latest.league!==stored.league||latest.eventId!==stored.eventId||
    latest.yesName!==stored.yesName||latest.noName!==stored.noName||
    stored.footballIdentity&&(!latest.footballIdentity||latest.footballIdentity.yesTeamId!==stored.footballIdentity.yesTeamId||latest.footballIdentity.noTeamId!==stored.footballIdentity.noTeamId)||
    !Number.isFinite(latest.observedAt)||latest.observedAt<stored.observedAt||latest.observedAt===stored.observedAt&&!newerDrive&&!sourceIssueChanged||latest.observedAt>now||
    latest.contextUpdatedAt!==null&&(!Number.isFinite(latest.contextUpdatedAt)||latest.contextUpdatedAt>now)||
    stored.contextUpdatedAt!==null&&(latest.contextUpdatedAt===null||latest.contextUpdatedAt<stored.contextUpdatedAt))return stored;
  // Catalog freshness must not reopen exchange metadata or replace its rules.
  return {...stored,live:latest.live,ended:latest.ended,active:exchangeActive&&stored.execution?.active===true&&latest.active,
    score:latest.score,period:latest.period,clock:latest.clock,football:latest.football,footballIdentity:latest.footballIdentity,footballSources:latest.footballSources,footballSourceIssue:latest.footballSourceIssue,tournament:latest.tournament,
    observedAt:latest.observedAt,contextUpdatedAt:latest.contextUpdatedAt,history:[]};
}
