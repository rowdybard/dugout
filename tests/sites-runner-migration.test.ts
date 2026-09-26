import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createTennisSession,defaultTennisConfig} from '../lib/tennis/engine.ts';
import {advanceMigration,activateMigration,prepareMigration,readMigration,packMigrationChunks,migrationStatus} from '../lib/runner/sites-migration.ts';
import {proxyRunnerSession,requireSitesOwner,runnerRequest} from '../lib/runner/sites-proxy.ts';
import {verifyRunnerRequest} from '../lib/runner/protocol.ts';
import type {RunnerDatabase,RunnerBindings} from '../lib/runner/sites-proxy';
import type {MigrationManifest} from '../lib/runner/contracts';
import type {TennisSession} from '../lib/tennis/types';

const owner='synthetic-owner-123',env:RunnerBindings={DUGOUT_OWNER_ID:owner,DUGOUT_RUNNER_URL:'https://paper.example.workers.dev',DUGOUT_RUNNER_SECRET:'synthetic-secret-at-least-thirty-two-characters'};
test('runner transport uses the edge-supported manual redirect mode and never forwards signed requests',async()=>{
  let calls=0;
  const request=(async(_url:RequestInfo|URL,init?:RequestInit)=>{calls++;assert.equal(init?.redirect,'manual');return new Response(null,{status:307,headers:{Location:'https://other.invalid/collect'}});}) as typeof fetch;
  await assert.rejects(runnerRequest(env,owner,'synthetic-epoch-123','/v1/state','GET',undefined,request),/redirect/);
  assert.equal(calls,1);
});
function harness(){
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE tennis_sessions(owner_id TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL);CREATE TABLE tennis_journal(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL);CREATE TABLE tennis_observations(id TEXT PRIMARY KEY,slug TEXT,time INTEGER,value TEXT NOT NULL);');
  sql.exec(readFileSync(new URL('../drizzle/0005_useful_jimmy_woo.sql',import.meta.url),'utf8'));
  let beforeBatch:(()=>void)|undefined;
  function prepare(query:string){let values:unknown[]=[];return {
    bind(...next:unknown[]){values=next;return this;},
    async first(){return sql.prepare(query).get(...values as never[])??null;},
    async all(){return {results:sql.prepare(query).all(...values as never[]),success:true};},
    async run(){const result=sql.prepare(query).run(...values as never[]);return {meta:{changes:Number(result.changes)},success:true};},
  };}
  const database={prepare,async batch(statements:ReturnType<typeof prepare>[]){if(beforeBatch){const call=beforeBatch;beforeBatch=undefined;call();}sql.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.run());sql.exec('COMMIT');return rows;}catch(error){sql.exec('ROLLBACK');throw error;}}} as unknown as RunnerDatabase;
  const session=createTennisSession(defaultTennisConfig(100),1000);session.status='running';
  sql.prepare('INSERT INTO tennis_sessions VALUES(?,?,?)').run(owner,JSON.stringify(session),0);
  const addJournal=(i:number,kind='decision',value:unknown={slug:'game-a',bookTime:10000+i})=>sql.prepare('INSERT INTO tennis_journal VALUES(?,?,?,?,?,?)').run(`${owner}:journal-${i}`,owner,session.id,kind,JSON.stringify(value),10000+i);
  const addObservation=(i:number)=>sql.prepare('INSERT INTO tennis_observations VALUES(?,?,?,?)').run(`game-a:${10000+i}`,'game-a',10000+i,JSON.stringify({market:{slug:'game-a'},receivedAt:10000+i}));
  return {sql,database,session,addJournal,addObservation,interleave:(call:()=>void)=>{beforeBatch=call;}};
}

test('requires a Sites owner and never accepts the private-owner fallback or unrelated headers',()=>{
  for(const headers of [{},{'x-dugout-owner':owner},{'oai-authenticated-user-id':'private-owner;spoof'}] as Record<string,string>[])assert.throws(()=>requireSitesOwner(new Request('https://site.example',{headers})),/Sign in/);
  assert.equal(requireSitesOwner(new Request('https://site.example',{headers:{'oai-authenticated-user-id':owner}})),owner);
});
test('signs only server-controlled owner/epoch and rejects redirect and oversized request bodies',async()=>{
  let calls=0;
  const fetcher:typeof fetch=async(input,init)=>{
    calls++;assert.equal(init?.redirect,'manual');
    const verified=await verifyRunnerRequest(new Request(String(input),init),env.DUGOUT_RUNNER_SECRET!);
    assert.equal(verified.owner,owner);assert.equal(verified.epoch,'epoch-12345678');
    assert.equal(verified.path,'/v1/state');
    return Response.json({okay:true});
  };
  assert.deepEqual(await runnerRequest(env,owner,'epoch-12345678','/v1/state','GET',undefined,fetcher),{okay:true});
  await assert.rejects(runnerRequest(env,owner,'epoch-12345678','/v1/command','POST',{large:'a'.repeat(1000000)},fetcher),/too large/);
  assert.equal(calls,1);
});
test('prepare atomically pauses a flat account, captures the journal boundary, and blocks old writers',async()=>{
  const h=harness();try{
    h.addJournal(1);h.addObservation(1);
    const row=await prepareMigration(h.database,owner,env,2000);
    assert.equal(row.mode,'frozen');assert.equal(JSON.parse(row.snapshot).status,'paused');assert.equal(row.journal_total,2);assert.equal(row.source_revision,1);
    const before=h.sql.prepare('SELECT value,revision FROM tennis_sessions').get();
    assert.throws(()=>h.sql.prepare('UPDATE tennis_sessions SET revision=revision+1 WHERE owner_id=?').run(owner),/fenced/);
    assert.throws(()=>h.addJournal(2),/fenced/);
    assert.throws(()=>h.sql.prepare('INSERT OR REPLACE INTO tennis_sessions VALUES(?,?,?)').run(owner,'{}',99),/fenced/);
    assert.deepEqual(h.sql.prepare('SELECT value,revision FROM tennis_sessions').get(),before);
    assert.equal((await prepareMigration(h.database,owner,env,3000)).migration_id,row.migration_id,'prepare retry is idempotent');
  }finally{h.sql.close();}
});
test('prepare refuses an open or pending position without freezing or changing the source',async()=>{
  for(const pending of [true,false]){
    const h=harness();try{
      const session={...h.session,...(pending?{pending:{action:'BUY'}}:{positions:[{status:'open'}]})};
      h.sql.prepare('UPDATE tennis_sessions SET value=?').run(JSON.stringify(session));
      await assert.rejects(prepareMigration(h.database,owner,env,2000),/open paper position/);
      assert.equal(await readMigration(h.database,owner),null);
      assert.equal(h.sql.prepare('SELECT value FROM tennis_sessions').get()?.value,JSON.stringify(session));
    }finally{h.sql.close();}
  }
});
test('a racing source update invalidates preparation instead of fencing a stale snapshot',async()=>{
  const h=harness();try{
    h.interleave(()=>h.sql.prepare('UPDATE tennis_sessions SET revision=1,value=?').run(JSON.stringify({...h.session,revision:1,pending:{action:'BUY'}})));
    await assert.rejects(prepareMigration(h.database,owner,env,2000),/session changed/);
    assert.equal(await readMigration(h.database,owner),null);
  }finally{h.sql.close();}
});
test('frozen accounts never fall back to browser commands or export',async()=>{
  const h=harness();try{
    await prepareMigration(h.database,owner,env,2000);
    const request=new Request('https://site.example/api/tennis/session',{headers:{'oai-authenticated-user-id':owner,origin:'https://site.example'}});
    assert.equal((await proxyRunnerSession(request,h.database,{}))?.status,200);
    await assert.rejects(proxyRunnerSession(request,h.database,{}, {action:'tick'}),/History is moving/);
    await assert.rejects(proxyRunnerSession(new Request('https://site.example/api/tennis/session?export=1',{headers:{'oai-authenticated-user-id':owner}}),h.database,{}),/History is moving/);
    await assert.rejects(proxyRunnerSession(new Request('https://site.example/api/tennis/session',{headers:{'oai-authenticated-user-id':owner,origin:'https://evil.example'}}),h.database,{}, {action:'pause'}),/origin/);
  }finally{h.sql.close();}
});
test('migration resumes bounded pages, deduplicates references, uploads exact chunks and activates only paused',async()=>{
  const h=harness();try{
    for(let i=0;i<730;i++){h.addJournal(i);h.addObservation(i);}
    h.addJournal(9999,'execution',{slug:'game-a',signalBookTime:10000,executionBookTime:10001});
    await prepareMigration(h.database,owner,env,20000);
    let manifest:MigrationManifest|undefined;let snapshot:TennisSession|undefined;const chunks=new Map<number,string>();
    const request:typeof runnerRequest=async<T>(_env:RunnerBindings,_owner:string,_epoch:string,path:string,_method?:'GET'|'POST',value?:unknown)=>{
      if(path==='/v1/migration/start'){const input=value as {manifest:MigrationManifest;session:TennisSession};manifest=input.manifest;snapshot=input.session;return {} as T;}
      if(path==='/v1/migration/chunk'){const chunk=value as {index:number;data:string};chunks.set(chunk.index,chunk.data);return {} as T;}
      if(path.startsWith('/v1/migration/status'))return {expectedChunks:manifest!.chunks.length,receivedChunks:[...chunks.keys()],activated:false} as T;
      if(path==='/v1/migration/activate')return {session:{...snapshot!,status:'paused',revision:snapshot!.revision+1},runner:{epoch:_epoch}} as T;
      throw new Error('Unexpected route');
    };
    let row=await advanceMigration(h.database,owner,env,{now:()=>21000,request});
    assert.equal(row.journal_done,600,'at most six local pages per call');assert.equal(row.phase,'journal');
    const initialRevision=row.revision;
    for(let attempt=0;attempt<20&&row.phase!=='ready';attempt++)row=await advanceMigration(h.database,owner,env,{now:()=>22000,request});
    assert.ok(row.revision>initialRevision);assert.equal(row.journal_done,732);assert.equal(row.observation_done,730);
    assert.equal(manifest!.observationCount,730);assert.equal(chunks.size,manifest!.chunks.length);
    const copied=[...chunks.values()].map(data=>JSON.parse(data));
    assert.equal(copied.reduce((n,data)=>n+data.journal.length,0),732);
    assert.equal(copied.reduce((n,data)=>n+data.observations.length,0),730);
    assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM tennis_journal').get()?.n,732);
    const active=await activateMigration(h.database,owner,env,{now:()=>23000,request});assert.equal(active.mode,'active');
    assert.equal((await migrationStatus(h.database,owner,env)).mode,'service');
  }finally{h.sql.close();}
});
test('missing referenced observations block activation and leave original history untouched',async()=>{
  const h=harness();try{
    h.addJournal(1);await prepareMigration(h.database,owner,env,2000);
    await assert.rejects(advanceMigration(h.database,owner,env),/source observation.*missing/);
    const row=(await readMigration(h.database,owner))!;
    assert.equal(row.phase,'observations');assert.match(row.error!,/missing/);assert.equal(row.mode,'frozen');
    assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM tennis_journal').get()?.n,2);
  }finally{h.sql.close();}
});
test('migration copies shadow-only pending and delayed fill observations without dropping or duplicating them',async()=>{
  const h=harness();try{
    h.addJournal(100,'shadow-exit',{slug:'game-a',pending:{bookTime:10001},fills:[{signalBookTime:10002,executionBookTime:10003},{signalBookTime:10002,executionBookTime:10003}]});
    for(const i of [1,2,3])h.addObservation(i);await prepareMigration(h.database,owner,env,20000);
    const chunks=new Map<number,string>();let manifest:MigrationManifest|undefined;
    const request:typeof runnerRequest=async<T>(_env:RunnerBindings,_owner:string,_epoch:string,path:string,_method?:'GET'|'POST',value?:unknown)=>{
      if(path==='/v1/migration/start'){manifest=(value as {manifest:MigrationManifest}).manifest;return {} as T;}
      if(path==='/v1/migration/chunk'){const chunk=value as {index:number;data:string};chunks.set(chunk.index,chunk.data);return {} as T;}
      throw new Error('Unexpected route');
    };
    let row=await advanceMigration(h.database,owner,env,{now:()=>21000,request});for(let i=0;i<10&&row.phase!=='ready';i++)row=await advanceMigration(h.database,owner,env,{now:()=>21000,request});
    assert.equal(row.phase,'ready');assert.equal(manifest?.observationCount,3);assert.equal(row.observation_done,3);
    const observations=[...chunks.values()].flatMap(data=>(JSON.parse(data) as {observations:{id:string}[]}).observations);assert.deepEqual(observations.map(r=>r.id).sort(),['game-a:10001','game-a:10002','game-a:10003']);
    assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM tennis_runner_refs').get()?.n,3);
  }finally{h.sql.close();}
});
test('competing migration checkpoints cannot append duplicate chunks or skip journal rows',async()=>{
  const h=harness();try{
    for(let i=0;i<20;i++){h.addJournal(i);h.addObservation(i);}await prepareMigration(h.database,owner,env,2000);
    h.interleave(()=>h.sql.prepare('UPDATE tennis_runner_owners SET revision=revision+1').run());
    await assert.rejects(advanceMigration(h.database,owner,env),/Another request advanced/);
    const row=(await readMigration(h.database,owner))!;assert.equal(row.journal_done,0);assert.equal(row.next_chunk,0);
    assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM tennis_runner_chunks').get()?.n,0);
  }finally{h.sql.close();}
});
test('chunk packing preserves unicode and whole rows and rejects oversized records',()=>{
  const rows=Array.from({length:10},(_,i)=>({id:`${owner}:${i}`,kind:'decision',time:i,value:{note:'🎾'.repeat(10000)}}));
  const packed=packMigrationChunks({journal:rows,observations:[]});
  assert.ok(packed.length>1);assert.deepEqual(packed.flatMap(data=>JSON.parse(data).journal),rows);
  assert.ok(packed.every(data=>new TextEncoder().encode(data).byteLength<=240000));
  assert.throws(()=>packMigrationChunks({journal:[{...rows[0],value:'a'.repeat(240001)}],observations:[]}),/preserved without truncation/);
});
test('streamed export aggregates missing evidence separately from pagination and retains replay boundary',async()=>{
  const h=harness(),originalFetch=globalThis.fetch;let calls=0;
  try{
    const fence=await prepareMigration(h.database,owner,env,2000);
    h.sql.prepare("UPDATE tennis_runner_owners SET mode='active',phase='active'").run();
    globalThis.fetch=async(input,init)=>{
      calls++;const url=new URL(String(input));
      const verified=await verifyRunnerRequest(new Request(url,init),env.DUGOUT_RUNNER_SECRET!);
      assert.equal(verified.owner,owner);
      const first=url.searchParams.get('after')==='0';
      return Response.json({schemaVersion:3,exportId:'immutable-export',capturedAt:3000,session:JSON.parse(fence.snapshot),
        records:[{id:first?'record1':'record2'}],observations:first?[{id:'input1',value:{}}]:[{id:'input1',value:{}},{id:'input2',value:{}}],
        nextCursor:first?1:2,complete:!first,pageEvidenceComplete:first,missingObservationIds:first?[]:['missing-input'],exactReplayStartsAt:'migration-checkpoint'});
    };
    const request=new Request('https://site.example/api/tennis/session?export=1',{headers:{'oai-authenticated-user-id':owner}});
    const response=await proxyRunnerSession(request,h.database,env);
    const exported=await response!.json() as {truncated:boolean;pageEvidenceComplete:boolean;exactReplayStartsAt:string;missingObservationIds:string[];recordCount:number;observationCount:number};
    assert.equal(exported.truncated,false);assert.equal(exported.pageEvidenceComplete,false);
    assert.equal(exported.exactReplayStartsAt,'migration-checkpoint');assert.deepEqual(exported.missingObservationIds,['missing-input']);
    assert.equal(exported.recordCount,2);assert.equal(exported.observationCount,2);assert.equal(calls,3);
  }finally{globalThis.fetch=originalFetch;h.sql.close();}
});
