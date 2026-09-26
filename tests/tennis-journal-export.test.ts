import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {exportTennisJournal} from '../lib/tennis/journal-export.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
type ExportDocument={session:ReturnType<typeof createTennisSession>;recordCount:number;records:{id:string;value:{cashDelta?:number}}[];observationCount:number;observations:{value:{book:{bids:{quantity:number}[]}}}[];missingObservationIds:string[];truncated:boolean};

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE tennis_sessions(owner_id TEXT PRIMARY KEY,value TEXT,revision INTEGER); CREATE TABLE tennis_journal(id TEXT PRIMARY KEY,owner_id TEXT,session_id TEXT,kind TEXT,value TEXT,created_at INTEGER); CREATE TABLE tennis_observations(id TEXT PRIMARY KEY,slug TEXT,time INTEGER,value TEXT);');
  const session=createTennisSession(undefined,1000);
  sqlite.prepare('INSERT INTO tennis_sessions VALUES(?,?,?)').run('owner',JSON.stringify(session),7);
  let reads=0;
  const prepare=(sql:string)=>{
    let values:unknown[]=[];
    const statement={bind(...args:unknown[]){values=args;return statement;},async first(){return sqlite.prepare(sql).get(...values as never[])??null;},async all(){reads++;return {results:sqlite.prepare(sql).all(...values as never[])};}};
    return statement;
  };
  // Only the platform methods used by the exporter are backed by real SQLite here.
  const database={prepare} as unknown as Pick<D1Database,'prepare'>;
  const add=(id:string,value:unknown={},owner='owner',sessionId=session.id,kind='decision')=>sqlite.prepare('INSERT INTO tennis_journal VALUES(?,?,?,?,?,?)').run(id,owner,sessionId,kind,JSON.stringify(value),2000);
  return {sqlite,session,database,add,reads:()=>reads};
}

test('full export exceeds 10,000 records, keeps tied timestamps and excludes later writes and other owners',async()=>{
  const f=fixture();
  for(let i=0;i<10002;i++)f.add(`d:${i}`,{i});
  f.add('private-other',{secret:'must not leak'},'someone-else');
  f.add('old-run',{},'owner','old-session');
  f.add('final-fill',{cashDelta:2.123,slug:'game',signalBookTime:123,executionBookTime:456},'owner',f.session.id,'execution');
  f.sqlite.prepare('INSERT INTO tennis_observations VALUES(?,?,?,?)').run('game:123','game',123,JSON.stringify({book:{bids:[{price:.5,quantity:20}]}}));
  const response=await exportTennisJournal(f.database,'owner');
  f.add('arrived-after-snapshot',{later:true});
  const data=await response.json() as ExportDocument;
  assert.equal(data.session.revision,7);assert.equal(data.recordCount,10003);assert.equal(data.records.length,10003);
  const last=data.records.at(-1);assert.ok(last);assert.equal(last.id,'final-fill');assert.equal(last.value.cashDelta,2.123);
  assert.equal(new Set(data.records.map((r:{id:string})=>r.id)).size,10003);
  assert.equal(data.records.some((r:{id:string})=>['private-other','old-run','arrived-after-snapshot'].includes(r.id)),false);
  assert.equal(data.truncated,false);assert.equal(data.observationCount,1);assert.deepEqual(data.missingObservationIds,['game:456']);
  assert.equal(data.observations[0].value.book.bids[0].quantity,20);
  assert.equal(response.headers.get('Cache-Control'),'no-store');f.sqlite.close();
});

test('empty journals export valid JSON and canceled downloads stop paging',async()=>{
  const f=fixture();
  const empty=await (await exportTennisJournal(f.database,'owner')).json() as ExportDocument;
  assert.equal(empty.recordCount,0);assert.deepEqual(empty.records,[]);assert.equal(empty.truncated,false);
  for(let i=0;i<1100;i++)f.add(`d:${i}`);
  const response=await exportTennisJournal(f.database,'owner'),reader=response.body!.getReader();
  await reader.read();await reader.cancel();
  const reads=f.reads();await Promise.resolve();assert.equal(f.reads(),reads);assert.ok(reads<=1);f.sqlite.close();
});

test('journal read failures cannot produce a valid file claiming a complete export',async()=>{
  const f=fixture();f.add('one');
  const response=await exportTennisJournal(f.database,'owner');
  f.sqlite.exec('DROP TABLE tennis_journal');
  await assert.rejects(response.json());f.sqlite.close();
});

test('three-hour focused watch fits the free D1 query budget with complete book evidence',async()=>{
  const f=fixture();
  for(let i=0;i<5000;i++){
    for(let side=0;side<4;side++)f.add(`d:${i}:${side}`,{slug:'game',bookTime:i});
    f.sqlite.prepare('INSERT INTO tennis_observations VALUES(?,?,?,?)').run(`game:${i}`,'game',i,JSON.stringify({receivedAt:i,book:{bids:[{price:.5,quantity:20}]}}));
  }
  const data=await (await exportTennisJournal(f.database,'owner')).json() as ExportDocument;
  assert.equal(data.recordCount,20000);assert.equal(data.observationCount,5000);assert.deepEqual(data.missingObservationIds,[]);
  assert.ok(f.reads()<40,'Leave query capacity for authentication and the snapshot');f.sqlite.close();
});
