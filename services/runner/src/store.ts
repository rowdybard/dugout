import {validateTennisConfig} from '../../../lib/tennis/engine.ts';
import {reduceRunnerAction} from '../../../lib/runner/reducer.ts';
import type {TennisAction,TennisInput,TennisSession} from '../../../lib/tennis/types';
import {toUnits} from '../../../lib/trading/money.ts';
import {RunnerError,sha256} from '../../../lib/runner/protocol.ts';
import type {MigrationChunk,MigrationData,MigrationManifest,MigrationStart,ReplayFrame,RunnerMeta,RunnerState,SourceHealth,RunnerUsage,RunnerCause} from '../../../lib/runner/contracts';

export type SqlRow=Record<string,SqlStorageValue>;
export interface RunnerSql {exec<T extends SqlRow=SqlRow>(sql:string,...bindings:(string|number|null)[]):{toArray():T[];rowsWritten?:number};}
export interface RunnerStorage {sql:RunnerSql;transactionSync<T>(fn:()=>T):T;}
const parse=<T>(s:string):T=>JSON.parse(s) as T;
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength;
const validHash=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const id=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(s);
const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)])):value;
const equivalent=(a:unknown,b:unknown)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
function assertCutover(session:TennisSession){
  if(!['idle','paused','stopped'].includes(session.status)||session.pending||session.positions.some(p=>p.status==='open'))throw new RunnerError(409,'Migration requires inactive entries, no open position and no pending order.');
  const positions=new Set(session.positions.map(p=>p.id));
  if(positions.size!==session.positions.length||session.ledger.some(e=>!positions.has(e.positionId)))throw new RunnerError(400,'Positions and execution ledger differ.');
  for(const p of session.positions){
    const ledger=session.ledger.filter(e=>e.positionId===p.id),buys=ledger.filter(e=>e.action==='BUY'),exits=ledger.filter(e=>e.action!=='BUY');
    if(!buys.length||!exits.length||p.quantity!==0||p.costBasis!==0||ledger.some(e=>e.slug!==p.slug||e.side!==p.side)||
      ledger.reduce((sum,e)=>sum+toUnits(e.cashDelta),0n)!==toUnits(p.realizedPnl)||
      -buys.reduce((sum,e)=>sum+toUnits(e.cashDelta),0n)!==toUnits(p.entryCost)||
      exits.reduce((sum,e)=>sum+toUnits(e.cashDelta),0n)!==toUnits(p.proceeds))throw new RunnerError(400,'Closed positions do not reconcile to the execution ledger.');
  }
}
function observationRefs(kind:string,value:Record<string,unknown>):string[]{
  if(typeof value.runnerFrameId==='string')return Array.isArray(value.runnerInputIds)?value.runnerInputIds.filter((v):v is string=>typeof v==='string'):[];
  if(typeof value.slug!=='string'||!value.slug)return [];
  const times:unknown[]=[value.bookTime,value.signalBookTime,value.executionBookTime];
  if(kind==='shadow-exit'){
    const shadow=value as {pending?:{bookTime?:number};fills?:{signalBookTime?:number;executionBookTime?:number}[]};
    times.push(shadow.pending?.bookTime,...(shadow.fills??[]).flatMap(f=>[f.signalBookTime,f.executionBookTime]));
  }
  return times.filter((t):t is number=>typeof t==='number'&&Number.isFinite(t)).map(t=>value.slug+':'+t);
}
function assertSession(session:TennisSession){
  if(!session||session.mode!=='paper'||typeof session.id!=='string'||!Number.isSafeInteger(session.revision)||session.revision<0||
    !Array.isArray(session.ledger)||!Array.isArray(session.positions)||!['idle','running','paused','stopping','stopped'].includes(session.status))throw new RunnerError(400,'Invalid paper snapshot.');
  const issue=validateTennisConfig(session.config);if(issue)throw new RunnerError(400,issue);
  if(session.config.maxSpreadPoints>2||session.config.maxBookAgeMs>5000)throw new RunnerError(400,'Runner spread and book-age limits cannot exceed 2 cents and 5 seconds.');
  if(session.positions.filter(p=>p.status==='open').length>1)throw new RunnerError(400,'Snapshot has multiple open positions.');
  try{const expected=session.ledger.reduce((sum,row)=>sum+toUnits(row.cashDelta),toUnits(session.config.startingCash));if(expected!==toUnits(session.cash)||session.cash<0)throw new Error('cash');}
  catch{throw new RunnerError(400,'Snapshot cash does not reconcile to its ledger.');}
  if(new Set(session.ledger.map(row=>row.id)).size!==session.ledger.length)throw new RunnerError(400,'Duplicate ledger commands.');
}
export class RunnerStore {
  private pendingWrites=0;
  private engineVersion:string;
  readonly storage:RunnerStorage;
  constructor(storage:RunnerStorage,engineVersion='shared-tennis-engine'){
    this.engineVersion=engineVersion;
    this.storage={sql:{exec:<T extends SqlRow>(query:string,...bindings:(string|number|null)[])=>{const cursor=storage.sql.exec<T>(query,...bindings);this.pendingWrites+=cursor.rowsWritten??0;return cursor;}},transactionSync:fn=>storage.transactionSync(fn)};
    storage.sql.exec('CREATE TABLE IF NOT EXISTS runner_meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS runner_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,value TEXT NOT NULL,time INTEGER NOT NULL,session_id TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS runner_inputs(id TEXT PRIMARY KEY,value TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS runner_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS runner_nonces(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS runner_imports(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,snapshot TEXT NOT NULL,activated INTEGER NOT NULL DEFAULT 0);'+
      'CREATE TABLE IF NOT EXISTS runner_chunks(migration_id TEXT NOT NULL,idx INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(migration_id,idx));'+
      'CREATE TABLE IF NOT EXISTS runner_stage_journal(migration_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(migration_id,id));'+
      'CREATE TABLE IF NOT EXISTS runner_stage_inputs(migration_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(migration_id,id));'+
      'CREATE TABLE IF NOT EXISTS runner_exports(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,boundary INTEGER NOT NULL,captured INTEGER NOT NULL);');
  }
  private rows<T extends SqlRow=SqlRow>(query:string,...bindings:(string|number|null)[]){return this.storage.sql.exec<T>(query,...bindings).toArray();}
  get<T>(key:string):T|null{const row=this.rows<{v:string}>('SELECT v FROM runner_meta WHERE k=?',key)[0];return row?parse<T>(row.v):null;}
  set(key:string,value:unknown){this.storage.sql.exec('INSERT INTO runner_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',key,JSON.stringify(value));}
  active(){return this.get<RunnerMeta>('active');}
  session(){return this.get<TennisSession>('session');}
  health():SourceHealth{return this.get<SourceHealth>('source')??{updatedAt:0,state:'stopped',message:'Runner has not started.'};}
  usage(now=Date.now()):RunnerUsage{const day=new Date(now).toISOString().slice(0,10),stored=this.get<RunnerUsage>('usage');return stored?.day===day?stored:{day,estimatedRowsWritten:0,alarmChecks:0,entryPauseAt:75000};}
  saveUsage(now=Date.now(),alarm=false){const usage=this.usage(now),pending=this.pendingWrites;this.pendingWrites=0;usage.estimatedRowsWritten+=pending+1;usage.alarmChecks+=Number(alarm);this.set('usage',usage);this.pendingWrites=0;return usage;}
  accountAlarmWrite(){this.pendingWrites++;}
  state():RunnerState{
    const session=this.session(),meta=this.active();if(!session||!meta)throw new RunnerError(409,'Runner migration is not active.');
    const now=Date.now(),slug=session.positions.find(p=>p.status==='open')?.slug??session.pending?.slug??session.config.focusSlug;
    const quote=slug?session.quotes?.[slug]:undefined,report=slug?session.footballReports?.[slug]?.report:undefined;
    const age=(time:number|undefined|null)=>typeof time==='number'&&Number.isFinite(time)&&time>=0&&time<=now?now-time:null;
    return {session,runner:{mode:'service',backgroundConnected:true,epoch:meta.epoch,lastTickAt:session.lastTickAt,lastEngineCheck:session.lastTickAt,quoteAgeMs:age(quote?.time),contextAgeMs:age(report?.reportTime),source:this.health(),usage:this.usage(now),paperOnly:true}};
  }
  acceptNonce(nonce:string,now:number){
    this.storage.transactionSync(()=>{this.storage.sql.exec('DELETE FROM runner_nonces WHERE expires<?',now);
      if(this.rows('SELECT id FROM runner_nonces WHERE id=?',nonce).length)throw new RunnerError(409,'Runner request nonce was already used.');
      this.storage.sql.exec('INSERT INTO runner_nonces(id,expires) VALUES(?,?)',nonce,now+65_000);
    });
  }
  assertIdentity(owner:string,epoch:string){const active=this.active();if(active&&(active.ownerId!==owner||active.epoch!==epoch))throw new RunnerError(409,'Runner owner or epoch does not match.');}
  assertCredentialIdentity(owner:string,epoch:string){
    this.assertIdentity(owner,epoch);if(this.active())return;
    if(!this.rows<{manifest:string}>('SELECT manifest FROM runner_imports').some(r=>{const m=parse<MigrationManifest>(r.manifest);return m.ownerId===owner&&m.epoch===epoch;}))throw new RunnerError(409,'Begin a matching migration before supplying provider credentials.');
  }
  async beginImport(payload:MigrationStart,owner:string,epoch:string){
    const {manifest:m,session}=payload??{};assertSession(session);assertCutover(session);
    if(!m||m.schemaVersion!==1||m.ownerId!==owner||m.epoch!==epoch||!id(m.migrationId)||m.sourceSessionId!==session.id||m.sourceRevision!==session.revision||
      !validHash(m.snapshotSha256)||!Number.isSafeInteger(m.journalCount)||m.journalCount<0||!Number.isSafeInteger(m.observationCount)||m.observationCount<0||
      !Array.isArray(m.chunks)||m.chunks.length>2000||m.journalCount>250000||m.observationCount>250000||m.chunks.reduce((sum,c)=>sum+c.byteLength,0)>64_000_000||m.chunks.some((c,i)=>c.index!==i||!validHash(c.sha256)||!Number.isInteger(c.byteLength)||c.byteLength<2||c.byteLength>250000))throw new RunnerError(400,'Invalid migration manifest.');
    const snapshot=JSON.stringify(session);if(bytes(snapshot)>900000||await sha256(snapshot)!==m.snapshotSha256)throw new RunnerError(400,'Snapshot hash differs.');
    const active=this.active();if(active&&active.migrationId!==m.migrationId)throw new RunnerError(409,'An active runner cannot be overwritten.');
    const saved=this.rows<{manifest:string,snapshot:string}>('SELECT manifest,snapshot FROM runner_imports WHERE id=?',m.migrationId)[0];
    if(saved){if(saved.manifest!==JSON.stringify(m)||saved.snapshot!==snapshot)throw new RunnerError(409,'Migration ID has different content.');return this.importStatus(m.migrationId);}
    this.storage.sql.exec('INSERT INTO runner_imports(id,manifest,snapshot) VALUES(?,?,?)',m.migrationId,JSON.stringify(m),snapshot);
    return this.importStatus(m.migrationId);
  }
  private imported(migrationId:string){const row=this.rows<{manifest:string,snapshot:string,activated:number}>('SELECT manifest,snapshot,activated FROM runner_imports WHERE id=?',migrationId)[0];if(!row)throw new RunnerError(404,'Migration was not found.');return {...row,manifest:parse<MigrationManifest>(row.manifest)};}
  importStatus(migrationId:string){
    const row=this.imported(migrationId);return {migrationId,epoch:row.manifest.epoch,sourceRevision:row.manifest.sourceRevision,activated:!!row.activated,
      receivedChunks:this.rows<{idx:number}>('SELECT idx FROM runner_chunks WHERE migration_id=? ORDER BY idx',migrationId).map(r=>r.idx),expectedChunks:row.manifest.chunks.length};
  }
  async importChunk(chunk:MigrationChunk,owner:string,epoch:string){
    if(!chunk||!Number.isInteger(chunk.index)||typeof chunk.data!=='string')throw new RunnerError(400,'Invalid migration chunk.');
    const imported=this.imported(chunk.migrationId),m=imported.manifest,expected=m.chunks[chunk.index];
    if(m.ownerId!==owner||m.epoch!==epoch)throw new RunnerError(409,'Migration identity differs.');
    if(!expected||bytes(chunk.data)!==expected.byteLength||await sha256(chunk.data)!==expected.sha256)throw new RunnerError(400,'Migration chunk hash differs.');
    const existing=this.rows<{hash:string}>('SELECT hash FROM runner_chunks WHERE migration_id=? AND idx=?',m.migrationId,chunk.index)[0];
    if(existing){if(existing.hash!==expected.sha256)throw new RunnerError(409,'Chunk content conflicts.');return this.importStatus(m.migrationId);}
    if(imported.activated)throw new RunnerError(409,'Activated migration is immutable.');
    let data:MigrationData;try{data=JSON.parse(chunk.data);}catch{throw new RunnerError(400,'Chunk is not JSON.');}
    if(!Array.isArray(data.journal)||!Array.isArray(data.observations)||data.journal.length+data.observations.length>2000)throw new RunnerError(400,'Invalid chunk rows.');
    this.storage.transactionSync(()=>{
      for(const row of data.journal){
        if(typeof row.id!=='string'||!row.id.startsWith(owner+':')||typeof row.kind!=='string'||!Number.isSafeInteger(row.time))throw new RunnerError(400,'Journal owner or timestamp differs.');
        this.storage.sql.exec('INSERT INTO runner_stage_journal(migration_id,id,kind,value,time) VALUES(?,?,?,?,?)',m.migrationId,row.id,row.kind,JSON.stringify(row.value),row.time);
      }
      for(const row of data.observations){
        if(typeof row.id!=='string'||!row.value?.market?.slug||!Number.isFinite(row.value.receivedAt)||row.id!==row.value.market.slug+':'+row.value.receivedAt)throw new RunnerError(400,'Invalid imported observation identity.');
        this.storage.sql.exec('INSERT INTO runner_stage_inputs(migration_id,id,value) VALUES(?,?,?)',m.migrationId,row.id,JSON.stringify(row.value));
      }
      this.storage.sql.exec('INSERT INTO runner_chunks(migration_id,idx,hash) VALUES(?,?,?)',m.migrationId,chunk.index,expected.sha256);
    });return this.importStatus(m.migrationId);
  }
  activate(migrationId:string,owner:string,epoch:string,now:number){
    const row=this.imported(migrationId),m=row.manifest;this.assertIdentity(owner,epoch);
    if(m.ownerId!==owner||m.epoch!==epoch)throw new RunnerError(409,'Migration identity differs.');
    if(row.activated)return this.state();
    const count=(table:string)=>Number(this.rows<{n:number}>('SELECT COUNT(*) AS n FROM '+table+' WHERE migration_id=?',migrationId)[0].n);
    if(count('runner_chunks')!==m.chunks.length||count('runner_stage_journal')!==m.journalCount||count('runner_stage_inputs')!==m.observationCount)throw new RunnerError(409,'Migration is incomplete.');
    // Verify each referenced legacy input is present before admitting the account.
    const session=parse<TennisSession>(row.snapshot);assertSession(session);assertCutover(session);
    const executions:Record<string,unknown>[]=[];let afterRow=0;
    // Keep staging validation bounded even when the source has a long journal.
    while(true){
      const page=this.rows<{rowid:number;kind:string;value:string}>('SELECT rowid,kind,value FROM runner_stage_journal WHERE migration_id=? AND rowid>? AND kind IN (?,?,?) ORDER BY rowid LIMIT 250',migrationId,afterRow,'decision','execution','shadow-exit');if(!page.length)break;
      const refs=new Set<string>();for(const r of page){const value=parse<Record<string,unknown>>(r.value);for(const ref of observationRefs(r.kind,value))refs.add(ref);if(r.kind==='execution'){const {configVersion,...entry}=value;void configVersion;executions.push(entry);if(executions.length>session.ledger.length)throw new RunnerError(409,'Snapshot executions do not match the complete imported execution journal.');}}
      const found=new Set(this.rows<{id:string}>('SELECT id FROM runner_stage_inputs WHERE migration_id=? AND id IN (SELECT value FROM json_each(?))',migrationId,JSON.stringify([...refs])).map(r=>r.id));
      if([...refs].some(ref=>!found.has(ref)))throw new RunnerError(409,'Referenced source observation is missing.');afterRow=page.at(-1)!.rowid;
    }
    if(executions.length!==session.ledger.length||session.ledger.some(entry=>executions.filter(e=>e.id===entry.id&&equivalent(e,entry)).length!==1))throw new RunnerError(409,'Snapshot executions do not match the complete imported execution journal.');
    if(session.status!=='stopped')session.status='paused';
    session.lastReason='History migrated. Paper runner is paused until you resume it.';
    // The observation window and all original ledger/positions survive migration.
    session.revision++;session.lastTickAt=Math.max(session.lastTickAt,now);
    this.storage.transactionSync(()=>{
      this.set('active',{ownerId:owner,epoch,migrationId,activatedAt:now} satisfies RunnerMeta);this.set('session',session);
      this.storage.sql.exec('INSERT INTO runner_journal(id,kind,value,time,session_id) SELECT id,kind,value,time,? FROM runner_stage_journal WHERE migration_id=? ORDER BY rowid',session.id,migrationId);
      this.storage.sql.exec('INSERT INTO runner_inputs(id,value) SELECT id,value FROM runner_stage_inputs WHERE migration_id=?',migrationId);
      this.storage.sql.exec('INSERT INTO runner_journal(id,kind,value,time,session_id) VALUES(?,?,?,?,?)',owner+':migration:'+migrationId,'migration',JSON.stringify({manifest:m,sourceSnapshot:parse<TennisSession>(row.snapshot),checkpoint:session,paused:true,sourceRevision:m.sourceRevision,activeRevision:session.revision}),now,session.id);
      this.storage.sql.exec('UPDATE runner_imports SET activated=1 WHERE id=?',migrationId);
      this.saveUsage(now);
    });return this.state();
  }
  commandResult(commandId:string,fingerprint:string){
    const row=this.rows<{fingerprint:string,response:string}>('SELECT fingerprint,response FROM runner_commands WHERE id=?',commandId)[0];
    if(!row)return null;if(row.fingerprint!==fingerprint)throw new RunnerError(409,'Command ID was reused with different instructions.');
    return this.state();
  }
  async advance(action:TennisAction,inputs:TennisInput[],now:number,sourceFailures:string[]=[],expectedRevision?:number,cause?:RunnerCause){
    const before=this.session(),meta=this.active();if(!before||!meta)throw new RunnerError(409,'Runner migration is not active.');
    if('sessionId' in action&&action.sessionId&&action.sessionId!==before.id)throw new RunnerError(409,'Session changed while fetching inputs.');
    if(expectedRevision!==undefined&&before.revision!==expectedRevision)throw new RunnerError(409,'Session changed while fetching inputs.');
    const commandId=action.commandId,fingerprint=JSON.stringify(action);
    if(commandId){const previous=this.commandResult(commandId,fingerprint);if(previous)return previous;}
    if(['start','resume'].includes(action.action)&&this.usage(now).estimatedRowsWritten>=this.usage(now).entryPauseAt)throw new RunnerError(409,'New entries are paused until the next UTC day because the runner write-budget estimate was reached.');
    if((action.action==='resume'||action.action==='start')&&!(action.action==='start'?action.config?.focusSlug??before.config.focusSlug:before.config.focusSlug))throw new RunnerError(400,'Choose one focused game before starting the runner.');
    if(commandId&&before.commandIds.includes(commandId))throw new RunnerError(409,'This command was already recorded before migration. Refresh the saved session.');
    const reduced=reduceRunnerAction(before,action,inputs,now,cause),next=reduced.session;
    if(next===before||next.id===before.id&&next.revision===before.revision)throw new RunnerError(409,'Session or clock changed. Refresh and retry.');
    assertSession(next);
    const inputRows=await Promise.all(inputs.map(async input=>{const value=JSON.stringify(input);return {id:await sha256(value),value};}));
    const frame:ReplayFrame={version:1,engineVersion:this.engineVersion,epoch:meta.epoch,now,sessionId:before.id,beforeRevision:before.revision,afterRevision:next.revision,action,inputIds:inputRows.map(r=>r.id),sourceFailures,beforeHash:await sha256(JSON.stringify(before)),afterHash:await sha256(JSON.stringify(next)),...(next.id!==before.id?{resetSessionId:next.id}:{}),...(reduced.clearObservationWindow?{clearObservationWindow:true}:{}),...(cause?{cause}:{})};
    return this.storage.transactionSync(()=>{
      const current=this.session(),identity=this.active();
      if(current?.id!==before.id||current.revision!==before.revision||identity?.epoch!==meta.epoch)throw new RunnerError(409,'Session changed while recording inputs.');
      for(const r of inputRows)this.storage.sql.exec('INSERT OR IGNORE INTO runner_inputs(id,value) VALUES(?,?)',r.id,r.value);
      const latest=inputs.toSorted((a,b)=>b.receivedAt-a.receivedAt)[0];if(latest)this.set('last-input',{receivedAt:latest.receivedAt,contextUpdatedAt:latest.market.contextUpdatedAt});
      const record=(id:string,kind:string,value:unknown,time:number)=>this.storage.sql.exec('INSERT INTO runner_journal(id,kind,value,time,session_id) VALUES(?,?,?,?,?)',id,kind,JSON.stringify(value),time,next.id);
      const evidence={runnerFrameId:meta.ownerId+':frame:'+next.id+':'+next.revision,runnerInputIds:frame.inputIds};
      const oldDecisions=new Set(before.decisions.map(d=>d.id)),oldLedger=new Set(before.ledger.map(e=>e.id));
      for(const d of next.decisions)if(!oldDecisions.has(d.id))record(meta.ownerId+':'+next.id+':'+d.id,'decision',{...d,...evidence},d.time);
      for(const e of next.ledger)if(!oldLedger.has(e.id))record(meta.ownerId+':'+next.id+':'+e.id,'execution',{...e,...evidence},e.time);
      for(const [positionId,shadow] of Object.entries(next.shadowExits??{}))if(!equivalent(shadow,before.shadowExits?.[positionId]))record(meta.ownerId+':shadow:'+positionId+':'+next.revision,'shadow-exit',{...shadow,...evidence},now);
      record(meta.ownerId+':frame:'+next.id+':'+next.revision,'replay',frame,now);
      if(commandId)record(meta.ownerId+':runner-command:'+commandId,'control',{action,fingerprint,...(cause?{cause}:{})},now);
      if(next.id!==before.id)record(meta.ownerId+':runner-archive:'+before.id,'archive',before,now);
      if(next.id!==before.id||next.revision%100===0)record(meta.ownerId+':checkpoint:'+next.id+':'+next.revision,'checkpoint',next,now);
      this.set('session',next);const response=this.state();
      if(commandId)this.storage.sql.exec('INSERT INTO runner_commands(id,fingerprint,response) VALUES(?,?,?)',commandId,fingerprint,JSON.stringify(response));
      this.saveUsage(now,action.action==='tick');
      return response;
    });
  }
  exportPage(exportId:string|null,after:number,limit:number,now:number){
    if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>500)throw new RunnerError(400,'Invalid export page.');
    let snapshot:{snapshot:string;boundary:number;captured:number};
    if(exportId){const saved=this.rows<typeof snapshot>('SELECT snapshot,boundary,captured FROM runner_exports WHERE id=?',exportId)[0];if(!saved)throw new RunnerError(404,'Export snapshot was not found.');snapshot=saved;}
    else {const session=this.session();if(!session)throw new RunnerError(409,'No active session.');exportId=crypto.randomUUID();snapshot={snapshot:JSON.stringify(session),boundary:Number(this.rows<{n:number}>('SELECT COALESCE(MAX(seq),0) AS n FROM runner_journal')[0].n),captured:now};
      this.storage.sql.exec('INSERT INTO runner_exports(id,snapshot,boundary,captured) VALUES(?,?,?,?)',exportId,snapshot.snapshot,snapshot.boundary,now);
      this.storage.sql.exec('DELETE FROM runner_exports WHERE captured<?',now-86400000);
    }
    const rows=this.rows<{seq:number,id:string,kind:string,value:string,time:number}>('SELECT seq,id,kind,value,time FROM runner_journal WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?',after,snapshot.boundary,limit);
    const records=rows.map(r=>({...r,value:parse<Record<string,unknown>>(r.value)})),ids=new Set<string>();
    for(const r of records){if(r.kind==='replay'&&Array.isArray(r.value.inputIds))r.value.inputIds.forEach(i=>{if(typeof i==='string')ids.add(i);});
      for(const ref of observationRefs(r.kind,r.value))ids.add(ref);
    }
    const missingObservationIds:string[]=[];
    const observations=[...ids].flatMap(id=>{const found=this.rows<{value:string}>('SELECT value FROM runner_inputs WHERE id=?',id)[0];if(!found)missingObservationIds.push(id);return found?[{id,value:parse<TennisInput>(found.value)}]:[];});
    const nextCursor=rows.at(-1)?.seq??after;
    return {schemaVersion:3,exportId,capturedAt:snapshot.captured,session:parse<TennisSession>(snapshot.snapshot),records,observations,missingObservationIds,pageEvidenceComplete:missingObservationIds.length===0,exactReplayStartsAt:'migration-checkpoint',nextCursor,complete:nextCursor>=snapshot.boundary};
  }
}
