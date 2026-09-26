import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {prepareMigration,advanceMigration,activateMigration,readMigration} from '../../../lib/runner/sites-migration.ts';
import {RunnerStore} from '../src/store.ts';
import {applyTennisAction,stepTennisSession} from '../../../lib/tennis/engine.ts';
import {OWNER,EPOCH,NOW,input,snapshot,sqlite} from './helpers.ts';
import type {RunnerBindings,RunnerDatabase,runnerRequest} from '../../../lib/runner/sites-proxy';
import type {MigrationChunk,MigrationStart} from '../../../lib/runner/contracts';
import type {TennisInput,TennisSession} from '../../../lib/tennis/types';

/** Exercise both real migration halves; no fabricated remote activation response. */
test('Sites chunks activate in the real runner with execution and shadow evidence; a lost activation response resumes safely',async()=>{
  const source=new DatabaseSync(':memory:'),remote=sqlite(),store=new RunnerStore(remote.storage);
  try{
    source.exec('CREATE TABLE tennis_sessions(owner_id TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL);CREATE TABLE tennis_journal(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,created_at INTEGER NOT NULL);CREATE TABLE tennis_observations(id TEXT PRIMARY KEY,slug TEXT,time INTEGER,value TEXT NOT NULL);');
    source.exec(readFileSync(new URL('../../../drizzle/0005_useful_jimmy_woo.sql',import.meta.url),'utf8'));
    function prepare(query:string){let values:unknown[]=[];return {
      bind(...next:unknown[]){values=next;return this;},
      async first(){return source.prepare(query).get(...values as never[])??null;},
      async all(){return {results:source.prepare(query).all(...values as never[]),success:true};},
      async run(){return {meta:{changes:Number(source.prepare(query).run(...values as never[]).changes)},success:true};},
    };}
    const db={prepare,async batch(statements:ReturnType<typeof prepare>[]){source.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());source.exec('COMMIT');return results;}catch(error){source.exec('ROLLBACK');throw error;}}} as unknown as RunnerDatabase;
    const journal=(session:TennisSession,id:string,kind:string,value:unknown,time:number)=>source.prepare('INSERT OR IGNORE INTO tennis_journal VALUES(?,?,?,?,?,?)').run(OWNER+':'+id,OWNER,session.id,kind,JSON.stringify(value),time);
    const observation=(quote:TennisInput)=>source.prepare('INSERT OR IGNORE INTO tennis_observations VALUES(?,?,?,?)').run(quote.market.slug+':'+quote.receivedAt,quote.market.slug,quote.receivedAt,JSON.stringify(quote));
    let session=applyTennisAction(snapshot(),{action:'resume',commandId:'historical-resume'},[],NOW+2);
    const step=(quote:TennisInput)=>{
      session=stepTennisSession(session,[quote],quote.receivedAt);observation(quote);
      for(const decision of session.decisions)journal(session,decision.id,'decision',decision,decision.time);
      for(const execution of session.ledger)journal(session,execution.id,'execution',{...execution,configVersion:session.config.version},execution.time);
    };
    for(let i=0;i<11;i++)step(input(NOW+4000+i*4000,.59,.60));
    for(const [offset,bid,ask] of [[48000,.45,.46],[50000,.48,.49],[52000,.49,.50],[54000,.49,.50],[56000,.55,.56],[58000,.55,.56]])step(input(NOW+offset,bid,ask));
    assert.deepEqual(session.ledger.map(row=>row.action),['BUY','SELL']);assert.equal(session.cash,100.23);session.status='paused';
    const shadowTimes=[NOW+90000,NOW+91000,NOW+92000];for(const time of shadowTimes)observation(input(time));
    journal(session,'shadow-only','shadow-exit',{slug:'synthetic-tennis',pending:{bookTime:shadowTimes[0]},fills:[{signalBookTime:shadowTimes[1],executionBookTime:shadowTimes[2]}]},NOW+93000);
    source.prepare('INSERT INTO tennis_sessions VALUES(?,?,?)').run(OWNER,JSON.stringify(session),session.revision);
    const originalSource=source.prepare('SELECT value FROM tennis_sessions').get()?.value;
    const originalRows=source.prepare('SELECT COUNT(*) AS n FROM tennis_journal').get()?.n;
    const env:RunnerBindings={DUGOUT_RUNNER_URL:'https://synthetic.example.workers.dev',DUGOUT_RUNNER_SECRET:'synthetic-secret-at-least-thirty-two-characters'};
    let activationResponseLost=false;
    const request:typeof runnerRequest=async<T>(_env:RunnerBindings,_owner:string,epoch:string,path:string,_method?:'GET'|'POST',value?:unknown)=>{
      assert.equal(_owner,OWNER);assert.notEqual(epoch,EPOCH);
      if(path==='/v1/migration/start')return await store.beginImport(value as MigrationStart,OWNER,epoch) as T;
      if(path==='/v1/migration/chunk')return await store.importChunk(value as MigrationChunk,OWNER,epoch) as T;
      if(path.startsWith('/v1/migration/status'))return store.importStatus(new URL('https://synthetic.invalid'+path).searchParams.get('migrationId')!) as T;
      if(path==='/v1/migration/activate'){
        const state=store.activate((value as {migrationId:string}).migrationId,OWNER,epoch,NOW+130000);
        if(!activationResponseLost){activationResponseLost=true;throw new Error('Simulated lost activation acknowledgement');}
        return state as T;
      }
      throw new Error('Unexpected migration request: '+path);
    };
    let progress=await prepareMigration(db,OWNER,env,NOW+120000);
    for(let i=0;i<20&&progress.phase!=='ready';i++)progress=await advanceMigration(db,OWNER,env,{now:()=>NOW+120000,request});
    assert.equal(progress.phase,'ready');assert.equal(store.session(),null);
    await assert.rejects(activateMigration(db,OWNER,env,{now:()=>NOW+130000,request}),/lost activation/);
    assert.equal((await readMigration(db,OWNER))?.mode,'frozen');assert.equal(store.session()?.status,'paused');
    assert.throws(()=>source.prepare('UPDATE tennis_sessions SET revision=revision+1').run(),/fenced/);
    const completed=await activateMigration(db,OWNER,env,{now:()=>NOW+130001,request});assert.equal(completed.mode,'active');
    assert.deepEqual(store.session()?.ledger,session.ledger);assert.equal(store.session()?.cash,100.23);
    const exported=store.exportPage(null,0,500,NOW+130002);assert.equal(exported.pageEvidenceComplete,true);assert.deepEqual(exported.missingObservationIds,[]);
    for(const time of shadowTimes)assert.ok(exported.observations.some(row=>row.id==='synthetic-tennis:'+time));
    assert.equal(source.prepare('SELECT value FROM tennis_sessions').get()?.value,originalSource);
    assert.equal(source.prepare('SELECT COUNT(*) AS n FROM tennis_journal').get()?.n,originalRows);
  }finally{source.close();remote.db.close();}
});
