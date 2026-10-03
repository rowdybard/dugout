import {accountBotIds,accountBotView,applyAccountAction} from '../tennis/account.ts';
import {normalizeTennisConfig} from '../tennis/rules.ts';
import {toUnits} from '../trading/money.ts';
import {polymarketSecrets} from '../trading/credentials.ts';
import {requireRunnerUser,runnerUserEnabled,siteOwnerEnabled} from '../server/owner-access.ts';
import {boundedBody,RunnerError,sha256} from './protocol.ts';
import {requireRunnerOrigin,requireSitesOwner,runnerConfiguration,runnerRequest} from './sites-proxy.ts';
import type {RunnerBindings,RunnerDatabase} from './sites-proxy';
import type {MigrationData,MigrationManifest,RunnerJournalRow,RunnerObservation,RunnerState} from './contracts';
import type {TennisAction,TennisSession} from '../tennis/types';

export const MIGRATION_CHUNK_TARGET=128*1024;
export const MIGRATION_CHUNK_MAX=240000;
const PAGE_ROWS=100;
const STEPS_PER_REQUEST=6;
const MAX_CHUNKS=2000;
const encoder=new TextEncoder();
const bytes=(value:string)=>encoder.encode(value).byteLength;
type MigrationPhase='journal'|'observations'|'ready'|'uploading'|'active';
export type MigrationOwner={
  owner_id:string;mode:'frozen'|'active';epoch:string;migration_id:string;source_session_id:string;source_revision:number;
  original_snapshot:string;snapshot:string;journal_through:number;journal_total:number;journal_cursor:number;journal_done:number;
  observation_cursor:string;observation_done:number;next_chunk:number;uploaded_chunks:number;remote_started:number;
  phase:MigrationPhase;manifest:string|null;revision:number;error:string|null;created_at:number;updated_at:number;
};
type JournalSqlRow={rowid:number;id:string;kind:string;value:string;created_at:number};
type MigrationDeps={now?:()=>number;request?:typeof runnerRequest};
export async function readMigration(database:RunnerDatabase,owner:string):Promise<MigrationOwner|null>{
  return database.prepare('SELECT * FROM tennis_runner_owners WHERE owner_id=?').bind(owner).first<MigrationOwner>();
}
export function reconcileMigrationSession(session:TennisSession):void{
  if(session.mode!=='paper'||!Array.isArray(session.positions)||!Array.isArray(session.ledger)||session.pending||session.bots?.tennis?.pending||session.positions.some(p=>p.status==='open'))throw new RunnerError(409,'Let both bots finish open paper positions and pending orders before moving history.');
  const expected=session.ledger.reduce((sum,row)=>sum+toUnits(row.cashDelta),toUnits(session.config.startingCash));
  if(expected!==toUnits(session.cash)||session.cash<0||new Set(session.ledger.map(row=>row.id)).size!==session.ledger.length)throw new RunnerError(409,'The saved paper ledger does not reconcile. History has not moved.');
}
export function referencedObservations(rows:RunnerJournalRow[]):string[]{
  const ids=new Set<string>();
  for(const row of rows){
    if(!['decision','execution','shadow-exit'].includes(row.kind)||!row.value||typeof row.value!=='object')continue;
    const value=row.value as {slug?:unknown;bookTime?:unknown;signalBookTime?:unknown;executionBookTime?:unknown;pending?:{bookTime?:unknown};fills?:{signalBookTime?:unknown;executionBookTime?:unknown}[]};
    if(typeof value.slug!=='string'||!value.slug)continue;
    const times=[value.bookTime,value.signalBookTime,value.executionBookTime];
    if(row.kind==='shadow-exit')times.push(value.pending?.bookTime,...(Array.isArray(value.fills)?value.fills.flatMap(fill=>[fill.signalBookTime,fill.executionBookTime]):[]));
    for(const time of times)if(typeof time==='number'&&Number.isFinite(time))ids.add(`${value.slug}:${time}`);
  }
  return [...ids];
}
/** Rows stay whole; an oversized legacy row is an explicit failure, never truncation. */
export function packMigrationChunks(data:MigrationData):string[]{
  const result:string[]=[];let current:MigrationData={journal:[],observations:[]};
  const flush=()=>{if(current.journal.length||current.observations.length){result.push(JSON.stringify(current));current={journal:[],observations:[]};}};
  for(const kind of ['journal','observations'] as const){
    for(const row of data[kind]){
      const next:MigrationData={journal:[...current.journal],observations:[...current.observations]};
      if(kind==='journal')next.journal.push(row as RunnerJournalRow);else next.observations.push(row as RunnerObservation);
      if(bytes(JSON.stringify(next))>MIGRATION_CHUNK_TARGET&&(current.journal.length||current.observations.length))flush();
      if(kind==='journal')current.journal.push(row as RunnerJournalRow);else current.observations.push(row as RunnerObservation);
      if(bytes(JSON.stringify(current))>MIGRATION_CHUNK_MAX)throw new RunnerError(409,'A saved history record exceeds the safe migration size. It was preserved without truncation.');
    }
  }
  flush();return result;
}
export async function migrationStatus(database:RunnerDatabase,owner:string,env:RunnerBindings){
  const eligible=runnerUserEnabled(owner,env);
  const row=await readMigration(database,owner);
  // Revoking eligibility must never describe an already-fenced account as local.
  if(!eligible)return {eligible:false,configured:false,mode:row?.mode==='active'?'service' as const:row?'migrating' as const:'browser' as const,phase:row?.phase??null,canPrepare:false,revision:row?.revision??0,progress:null,error:row?'Background running is not enabled for this account. The existing account remains protected.':null};
  let configured=true;try{runnerConfiguration(env);}catch{configured=false;}
  if(!row){
    const source=await database.prepare('SELECT value FROM tennis_sessions WHERE owner_id=?').bind(owner).first<{value:string}>();
    let canPrepare=false;if(source){try{const session=JSON.parse(source.value) as TennisSession;session.config=normalizeTennisConfig(session.config);reconcileMigrationSession(session);canPrepare=true;}catch{/* Preserve the old session and explain through prepare's specific error. */}}
    return {eligible,configured,mode:'browser' as const,phase:null,canPrepare:configured&&canPrepare,revision:0,progress:null,error:null};
  }
  const count=await database.prepare('SELECT COUNT(*) AS n FROM tennis_runner_refs WHERE owner_id=? AND epoch=?').bind(owner,row.epoch).first<{n:number}>();
  return {eligible,configured,mode:row.mode==='active'?'service' as const:'migrating' as const,phase:row.phase,canPrepare:false,revision:row.revision,
    progress:{journalDone:row.journal_done,journalTotal:row.journal_total,observationDone:row.observation_done,observationTotal:count?.n??0,chunksBuilt:row.next_chunk,chunksUploaded:row.uploaded_chunks},error:row.error};
}

export async function prepareMigration(database:RunnerDatabase,owner:string,env:RunnerBindings,now=Date.now()):Promise<MigrationOwner>{
  requireRunnerUser(owner,env);
  runnerConfiguration(env);
  const existing=await readMigration(database,owner);if(existing)return existing;
  const source=await database.prepare('SELECT value,revision FROM tennis_sessions WHERE owner_id=?').bind(owner).first<{value:string;revision:number}>();
  if(!source)throw new RunnerError(409,'No saved paper session is available to move.');
  const original=JSON.parse(source.value) as TennisSession;
  const session={...original,revision:source.revision,config:normalizeTennisConfig(original.config)};
  reconcileMigrationSession(session);
  if(accountBotIds(session).some(botId=>accountBotView(session,botId).status==='stopping'))throw new RunnerError(409,'Let the saved stop commands finish before moving history.');
  const migrationId=crypto.randomUUID(),epoch=crypto.randomUUID(),actions:TennisAction[]=[];
  let paused=session;
  for(const botId of accountBotIds(session))if(accountBotView(session,botId).status==='running'){
    const action:TennisAction={action:'pause',...(session.bots?{botId}:{}),sessionId:session.id,commandId:crypto.randomUUID()};
    paused=applyAccountAction(paused,action,[],Math.max(now,paused.lastTickAt));actions.push(action);
  }
  if(accountBotIds(paused).some(botId=>accountBotView(paused,botId).status==='running'))throw new RunnerError(409,'The paper bots could not be paused.');
  reconcileMigrationSession(paused);
  const snapshot=JSON.stringify(paused);
  // Leaves room for the complete chunk manifest inside the 1 MB signed envelope.
  if(bytes(snapshot)>650000)throw new RunnerError(409,'The saved session is too large for one verified snapshot. It has not been frozen.');
  const largest=await database.prepare('SELECT COALESCE(MAX(length(CAST(value AS BLOB))),0) AS n FROM tennis_journal WHERE owner_id=? AND session_id=?').bind(owner,session.id).first<{n:number}>();
  if((largest?.n??0)>MIGRATION_CHUNK_MAX-2000)throw new RunnerError(409,'A saved journal record requires a larger migration format. It has not been frozen.');
  const statements:D1PreparedStatement[]=[];
  if(paused!==session){
    statements.push(database.prepare('UPDATE tennis_sessions SET value=?,revision=? WHERE owner_id=? AND revision=? AND value=? AND NOT EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=?)').bind(snapshot,paused.revision,owner,source.revision,source.value,owner));
    for(const action of actions)statements.push(database.prepare("INSERT INTO tennis_journal(id,owner_id,session_id,kind,value,created_at) SELECT ?,?,?, 'control',?,? FROM tennis_sessions WHERE owner_id=? AND revision=? AND value=? AND NOT EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=?)")
      .bind(`${owner}:command:${action.commandId}`,owner,session.id,JSON.stringify({fingerprint:JSON.stringify(action),action,sessionId:session.id}),now,owner,paused.revision,snapshot,owner));
  }
  const expectedValue=paused===session?source.value:snapshot;
  statements.push(database.prepare(`INSERT INTO tennis_runner_owners(owner_id,mode,epoch,migration_id,source_session_id,source_revision,original_snapshot,snapshot,journal_through,journal_total,phase,created_at,updated_at)
    SELECT ?,'frozen',?,?,?,?,?,?,(SELECT COALESCE(MAX(rowid),0) FROM tennis_journal WHERE owner_id=? AND session_id=?),(SELECT COUNT(*) FROM tennis_journal WHERE owner_id=? AND session_id=?),'journal',?,?
    FROM tennis_sessions WHERE owner_id=? AND revision=? AND value=? AND NOT EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=?)`)
    .bind(owner,epoch,migrationId,session.id,paused.revision,source.value,snapshot,owner,session.id,owner,session.id,now,now,owner,paused.revision,expectedValue,owner));
  await database.batch(statements);
  const saved=await readMigration(database,owner);
  if(!saved)throw new RunnerError(409,'The session changed before it could be frozen. Review the current account and retry.');
  return saved;
}

async function checkpoint(database:RunnerDatabase,row:MigrationOwner,chunks:string[],refs:string[],patch:Partial<Pick<MigrationOwner,'phase'|'journal_cursor'|'journal_done'|'observation_cursor'|'observation_done'|'manifest'|'remote_started'|'uploaded_chunks'|'mode'>>,now:number):Promise<MigrationOwner>{
  if(row.next_chunk+chunks.length>MAX_CHUNKS)throw new RunnerError(409,'History exceeds the migration chunk limit. The complete source remains frozen and preserved.');
  const guard='EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=? AND epoch=? AND revision=?)';
  const statements:D1PreparedStatement[]=[];
  for(const [offset,data] of chunks.entries())statements.push(database.prepare(`INSERT INTO tennis_runner_chunks(owner_id,epoch,idx,data,sha256,byte_length) SELECT ?,?,?,?,?,? WHERE ${guard}`)
    .bind(row.owner_id,row.epoch,row.next_chunk+offset,data,await sha256(data),bytes(data),row.owner_id,row.epoch,row.revision));
  if(refs.length)statements.push(database.prepare(`INSERT OR IGNORE INTO tennis_runner_refs(owner_id,epoch,observation_id) SELECT ?,?,value FROM json_each(?) WHERE ${guard}`)
    .bind(row.owner_id,row.epoch,JSON.stringify(refs),row.owner_id,row.epoch,row.revision));
  const entries=Object.entries({...patch,next_chunk:row.next_chunk+chunks.length,error:null,updated_at:now});
  statements.push(database.prepare(`UPDATE tennis_runner_owners SET ${entries.map(([key])=>key+'=?').join(',')},revision=revision+1 WHERE owner_id=? AND epoch=? AND revision=?`)
    .bind(...entries.map(([,value])=>value),row.owner_id,row.epoch,row.revision));
  const result=await database.batch(statements);
  const current=await readMigration(database,row.owner_id);
  if(!current)throw new RunnerError(409,'Migration checkpoint was lost.');
  if(!result.at(-1)?.meta.changes)throw new RunnerError(409,'Another request advanced this migration. Reload its current progress.');
  return current;
}

async function buildPage(database:RunnerDatabase,row:MigrationOwner,now:number):Promise<MigrationOwner>{
  if(row.phase==='journal'){
    const page=await database.prepare('SELECT rowid,id,kind,value,created_at FROM tennis_journal WHERE owner_id=? AND session_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?')
      .bind(row.owner_id,row.source_session_id,row.journal_cursor,row.journal_through,PAGE_ROWS).all<JournalSqlRow>();
    if(!page.results.length&&row.journal_cursor<row.journal_through)throw new RunnerError(409,'The frozen journal boundary is missing records.');
    const journal=page.results.map(r=>({id:r.id,kind:r.kind,value:JSON.parse(r.value),time:r.created_at}));
    const cursor=page.results.at(-1)?.rowid??row.journal_cursor,done=row.journal_done+journal.length;
    if(cursor>=row.journal_through&&done!==row.journal_total)throw new RunnerError(409,'Frozen journal counts do not match.');
    return checkpoint(database,row,packMigrationChunks({journal,observations:[]}),referencedObservations(journal),{journal_cursor:cursor,journal_done:done,...(cursor>=row.journal_through?{phase:'observations' as const}:{})},now);
  }
  if(row.phase==='observations'){
    const page=await database.prepare('SELECT r.observation_id AS id,o.value FROM tennis_runner_refs r LEFT JOIN tennis_observations o ON o.id=r.observation_id WHERE r.owner_id=? AND r.epoch=? AND r.observation_id>? ORDER BY r.observation_id LIMIT ?')
      .bind(row.owner_id,row.epoch,row.observation_cursor,PAGE_ROWS).all<{id:string;value:string|null}>();
    if(page.results.some(r=>r.value===null))throw new RunnerError(409,'A source observation referenced by the journal is missing. Activation is blocked; original history is preserved.');
    const observations=page.results.map(r=>({id:r.id,value:JSON.parse(r.value!)})) as RunnerObservation[];
    for(const observation of observations)if(observation.id!==`${observation.value.market?.slug}:${observation.value.receivedAt}`)throw new RunnerError(409,'A source observation identity differs from its saved record.');
    const next=await checkpoint(database,row,packMigrationChunks({journal:[],observations}),[],{observation_cursor:page.results.at(-1)?.id??row.observation_cursor,observation_done:row.observation_done+observations.length,...(page.results.length<PAGE_ROWS?{phase:'uploading' as const}:{})},now);
    return next;
  }
  return row;
}
async function buildManifest(database:RunnerDatabase,row:MigrationOwner):Promise<MigrationManifest>{
  reconcileMigrationSession(JSON.parse(row.snapshot) as TennisSession);
  const chunks=await database.prepare('SELECT idx AS "index",sha256,byte_length AS byteLength FROM tennis_runner_chunks WHERE owner_id=? AND epoch=? ORDER BY idx').bind(row.owner_id,row.epoch).all<{index:number;sha256:string;byteLength:number}>();
  const refs=await database.prepare('SELECT COUNT(*) AS n FROM tennis_runner_refs WHERE owner_id=? AND epoch=?').bind(row.owner_id,row.epoch).first<{n:number}>();
  if(row.journal_done!==row.journal_total||row.observation_done!==(refs?.n??0)||chunks.results.length!==row.next_chunk||chunks.results.some((chunk,i)=>chunk.index!==i))throw new RunnerError(409,'History migration counts do not reconcile.');
  return {schemaVersion:1,migrationId:row.migration_id,ownerId:row.owner_id,epoch:row.epoch,sourceSessionId:row.source_session_id,sourceRevision:row.source_revision,snapshotSha256:await sha256(row.snapshot),journalCount:row.journal_done,observationCount:row.observation_done,chunks:chunks.results};
}
async function uploadStep(database:RunnerDatabase,row:MigrationOwner,env:RunnerBindings,now:number,request:typeof runnerRequest):Promise<MigrationOwner>{
  if(!row.manifest){const manifest=await buildManifest(database,row);return checkpoint(database,row,[],[],{manifest:JSON.stringify(manifest),phase:'uploading'},now);}
  if(!row.remote_started){
    await request(env,row.owner_id,row.epoch,'/v1/migration/start','POST',{manifest:JSON.parse(row.manifest),session:JSON.parse(row.snapshot)});
    return checkpoint(database,row,[],[],{remote_started:1},now);
  }
  if(row.remote_started===1){
    // The owner's Polymarket key streams prices for the owner's runner only; other accounts' runners use REST checks.
    const credentials=siteOwnerEnabled(row.owner_id,env)?polymarketSecrets(env as Record<string,unknown>):null;
    if(credentials)await request(env,row.owner_id,row.epoch,'/v1/feed-credentials','POST',credentials);
    return checkpoint(database,row,[],[],{remote_started:2},now);
  }
  if(row.uploaded_chunks<row.next_chunk){
    const chunk=await database.prepare('SELECT idx,data FROM tennis_runner_chunks WHERE owner_id=? AND epoch=? AND idx=?').bind(row.owner_id,row.epoch,row.uploaded_chunks).first<{idx:number;data:string}>();
    if(!chunk)throw new RunnerError(409,'A prepared migration chunk is missing.');
    await request(env,row.owner_id,row.epoch,'/v1/migration/chunk','POST',{migrationId:row.migration_id,index:chunk.idx,data:chunk.data});
    return checkpoint(database,row,[],[],{uploaded_chunks:row.uploaded_chunks+1},now);
  }
  return row.phase==='ready'?row:checkpoint(database,row,[],[],{phase:'ready'},now);
}
export async function advanceMigration(database:RunnerDatabase,owner:string,env:RunnerBindings,deps:MigrationDeps={}):Promise<MigrationOwner>{
  requireRunnerUser(owner,env);
  const now=deps.now??Date.now,request=deps.request??runnerRequest;
  let row=await readMigration(database,owner);if(!row)throw new RunnerError(409,'Prepare the saved history migration first.');
  if(row.mode==='active'||row.phase==='ready')return row;
  // One final 15-second upstream call still fits the dashboard's 25-second limit.
  const deadline=now()+8000;
  try{
    for(let step=0;step<STEPS_PER_REQUEST&&now()<deadline;step++){
      const before=row.revision;
      row=row.phase==='journal'||row.phase==='observations'?await buildPage(database,row,now()):await uploadStep(database,row,env,now(),request);
      if(row.revision===before)break;
    }
    return row;
  }catch(error){
    // Preserve the last committed cursor. No source mutation or reset is attempted.
    if(!(error instanceof RunnerError&&error.status===409&&error.message.startsWith('Another request'))){
      const message=error instanceof RunnerError?error.message:'Migration could not advance. Its saved checkpoint is safe to retry.';
      await database.prepare('UPDATE tennis_runner_owners SET error=?,updated_at=?,revision=revision+1 WHERE owner_id=? AND epoch=? AND revision=?').bind(message,now(),owner,row.epoch,row.revision).run();
    }
    throw error;
  }
}
export async function activateMigration(database:RunnerDatabase,owner:string,env:RunnerBindings,deps:MigrationDeps={}):Promise<MigrationOwner>{
  requireRunnerUser(owner,env);
  const now=deps.now??Date.now,request=deps.request??runnerRequest;
  const row=await readMigration(database,owner);if(!row)throw new RunnerError(409,'No prepared migration exists.');if(row.mode==='active')return row;
  if(row.phase!=='ready'||!row.manifest||row.remote_started!==2||row.uploaded_chunks!==row.next_chunk)throw new RunnerError(409,'Finish copying and verifying all saved history before activation.');
  const status=await request<{activated:boolean;receivedChunks:number[];expectedChunks:number}>(env,owner,row.epoch,`/v1/migration/status?migrationId=${encodeURIComponent(row.migration_id)}`);
  if(status.expectedChunks!==row.next_chunk||status.receivedChunks.length!==row.next_chunk||new Set(status.receivedChunks).size!==row.next_chunk||status.receivedChunks.some((index,i)=>index!==i))throw new RunnerError(409,'The background runner has not verified every migration chunk.');
  // Remote activation is idempotent. If the following D1 CAS fails, retry it; the
  // source remains frozen throughout, so there is never a second writer.
  const active=await request<RunnerState>(env,owner,row.epoch,'/v1/migration/activate','POST',{migrationId:row.migration_id});
  const expected=JSON.parse(row.snapshot) as TennisSession;
  const expectedStatus=expected.status==='stopped'?'stopped':'paused';
  if(active.runner?.epoch!==row.epoch||active.session?.id!==row.source_session_id||active.session.status!==expectedStatus||active.session.pending||active.session.positions.some(p=>p.status==='open')||toUnits(active.session.cash)!==toUnits(expected.cash)||JSON.stringify(active.session.ledger)!==JSON.stringify(expected.ledger))throw new RunnerError(409,'The activated account does not match its verified inactive snapshot. Browser trading remains fenced.');
  if(expected.bots?.tennis){
    const tennis=active.session.bots?.tennis;
    if(!tennis||tennis.pending||tennis.status!==(expected.bots.tennis.status==='stopped'?'stopped':'paused')||JSON.stringify(tennis.config)!==JSON.stringify(expected.bots.tennis.config))throw new RunnerError(409,'The activated Tennis bot does not match its verified inactive snapshot.');
  }
  return checkpoint(database,row,[],[],{mode:'active',phase:'active'},now());
}
export async function handleRunnerMigration(request:Request,database:RunnerDatabase,env:RunnerBindings):Promise<Response>{
  const owner=requireSitesOwner(request);
  if(request.method==='GET')return Response.json(await migrationStatus(database,owner,env),{headers:{'Cache-Control':'no-store'}});
  if(request.method!=='POST')throw new RunnerError(405,'Unsupported migration method.');
  requireRunnerOrigin(request);
  requireRunnerUser(owner,env);
  const body=await boundedBody(request,1024);
  let input:{action?:unknown};try{input=JSON.parse(body);}catch{throw new RunnerError(400,'Invalid migration command.');}
  if(!input||typeof input!=='object'||Object.keys(input).length!==1)throw new RunnerError(400,'Choose one migration action.');
  if(input.action==='prepare')await prepareMigration(database,owner,env);
  else if(input.action==='advance')await advanceMigration(database,owner,env);
  else if(input.action==='activate')await activateMigration(database,owner,env);
  else throw new RunnerError(400,'Choose a supported migration action.');
  return Response.json(await migrationStatus(database,owner,env),{headers:{'Cache-Control':'no-store'}});
}
