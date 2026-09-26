import type {TennisAction,TennisInput,TennisMarket,TennisSession} from '../tennis/types';

export const RUNNER_PROTOCOL='DUGOUT-RUNNER-V1';
export type RunnerJournalRow={id:string;kind:string;value:unknown;time:number};
export type RunnerObservation={id:string;value:TennisInput};
export type MigrationManifest={
  schemaVersion:1;migrationId:string;ownerId:string;epoch:string;sourceSessionId:string;sourceRevision:number;
  snapshotSha256:string;journalCount:number;observationCount:number;
  chunks:{index:number;sha256:string;byteLength:number}[];
};
export type MigrationStart={manifest:MigrationManifest;session:TennisSession};
export type MigrationChunk={migrationId:string;index:number;data:string};
export type MigrationData={journal:RunnerJournalRow[];observations:RunnerObservation[]};
export type RunnerCommand={command:TennisAction};
export type RunnerCause={code:'FOCUSED_GAME_ENDED'|'WRITE_BUDGET';market?:TennisMarket};
export type ReplayFrame={
  version:1;engineVersion:string;epoch:string;now:number;sessionId:string;beforeRevision:number;afterRevision:number;
  action:TennisAction;inputIds:string[];sourceFailures:string[];beforeHash:string;afterHash:string;resetSessionId?:string;clearObservationWindow?:boolean;cause?:RunnerCause;
};
export type RunnerMeta={ownerId:string;epoch:string;migrationId:string;activatedAt:number};
export type SourceHealth={updatedAt:number;state:'starting'|'streaming'|'rest'|'waiting'|'error'|'stopped';message:string};
export type RunnerUsage={day:string;estimatedRowsWritten:number;alarmChecks:number;entryPauseAt:number};
export type RunnerState={session:TennisSession;runner:{mode:'service';backgroundConnected:true;epoch:string;lastTickAt:number;lastEngineCheck:number;quoteAgeMs:number|null;contextAgeMs:number|null;source:SourceHealth;usage:RunnerUsage;paperOnly:true}};
export function runnable(session:TennisSession):boolean {
  return session.status==='running'||session.status==='stopping'||session.positions.some(p=>p.status==='open')||!!session.pending;
}
