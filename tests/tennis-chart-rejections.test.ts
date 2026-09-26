import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {CHART_HISTORY_SQL,readChartRejections} from '../lib/tennis/chart-rejections.ts';

const NOW=Date.parse('2026-09-26T04:00:00Z');
const WINDOW=6*60*60_000;
const plain=(value:Record<string,number[]>)=>JSON.parse(JSON.stringify(value)) as Record<string,number[]>;

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE tennis_journal(id TEXT PRIMARY KEY,owner_id TEXT,session_id TEXT,kind TEXT,value TEXT,created_at INTEGER); CREATE TABLE tennis_observations(id TEXT PRIMARY KEY,slug TEXT,time INTEGER,value TEXT); CREATE INDEX tennis_observations_slug_time ON tennis_observations(slug,time);');
  let creates=0,failNextCreate=false,lastRead='',nextCreatePause:Promise<void>|null=null;
  const database={prepare(sql:string){
    let args:unknown[]=[];
    const statement={
      bind(...values:unknown[]){args=values;return statement;},
      async run(){
        if(sql.startsWith('CREATE INDEX')){
          creates++;
          const pause=nextCreatePause;nextCreatePause=null;if(pause)await pause;
          if(failNextCreate){failNextCreate=false;throw new Error('index creation unavailable');}
        }
        return sqlite.prepare(sql).run(...args as never[]);
      },
      async all(){lastRead=sql;return {results:sqlite.prepare(sql).all(...args as never[])};},
    };
    return statement;
  }} as unknown as Pick<D1Database,'prepare'>;
  const add=(id:string,owner:string,session:string,value:unknown,createdAt=NOW,kind='decision')=>
    sqlite.prepare('INSERT INTO tennis_journal VALUES(?,?,?,?,?,?)').run(id,owner,session,kind,JSON.stringify(value),createdAt);
  return {sqlite,database,add,creates:()=>creates,lastRead:()=>lastRead,failCreate:()=>{failNextCreate=true;},pauseCreate:()=>{let resolve!:()=>void,reject!:(error:Error)=>void;nextCreatePause=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject};}};
}

test('rejections remain owner-fenced across resets, deduplicated and within the six-hour window',async()=>{
  const f=fixture(),early=NOW-WINDOW;
  f.add('old-run','owner-a','session-1',{code:'BOOK_ORDER',slug:'game-a',bookTime:early},early);
  f.add('new-run','owner-a','session-2',{code:'BOOK_ORDER',slug:'game-a',bookTime:NOW-1000});
  f.add('duplicate','owner-a','session-2',{code:'BOOK_ORDER',slug:'game-a',bookTime:NOW-1000});
  f.add('other-game','owner-a','session-2',{code:'BOOK_ORDER',slug:'game-b',bookTime:NOW-500});
  f.add('other-owner','owner-b','session-3',{code:'BOOK_ORDER',slug:'private-game',bookTime:NOW-300});
  f.add('not-a-rejection','owner-a','session-2',{code:'HOLDING',slug:'game-a',bookTime:NOW-200});
  const before=f.sqlite.prepare('SELECT id,owner_id,session_id,kind,value,created_at FROM tennis_journal ORDER BY id').all();
  const [a,b]=await Promise.all([readChartRejections(f.database,'owner-a',NOW),readChartRejections(f.database,'owner-b',NOW)]);
  assert.deepEqual(plain(a),{'game-a':[early,NOW-1000],'game-b':[NOW-500]});
  assert.deepEqual(plain(b),{'private-game':[NOW-300]});
  assert.equal(f.creates(),2,'concurrent requests each own an idempotent index build');
  assert.deepEqual(await readChartRejections(f.database,'owner-a',NOW),a);
  assert.equal(f.creates(),2);
  assert.deepEqual(f.sqlite.prepare('SELECT id,owner_id,session_id,kind,value,created_at FROM tennis_journal ORDER BY id').all(),before,'lookup never rewrites evidence');
  const plan=f.sqlite.prepare(`EXPLAIN QUERY PLAN ${f.lastRead()}`).all('owner-a',early,NOW);
  assert.ok(plan.some(row=>String(row.detail).includes('tennis_journal_order_rejections')),JSON.stringify(plan));
  f.sqlite.close();
});

test('invalid slugs, unsafe or out-of-window book times, and outside-window decisions are excluded',async()=>{
  const f=fixture();
  const bad:[string,unknown,number][]=[
    ['empty',NOW-1,NOW],['slash',NOW-1,NOW],['old',NOW-WINDOW-1,NOW],
    ['future',NOW+1,NOW],['zero',0,NOW],['negative',-1,NOW],
    ['fraction',NOW-.5,NOW],['unsafe',Number.MAX_SAFE_INTEGER+1,NOW],
    ['string',String(NOW-1),NOW],['null',null,NOW],['decision-old',NOW-1,NOW-WINDOW-1],
    ['decision-future',NOW-1,NOW+1],
  ];
  for(const [id,bookTime,createdAt] of bad){
    const slug=id==='empty'?'':id==='slash'?'bad/slug':'game';
    f.add(id,'owner','session',{code:'BOOK_ORDER',slug,bookTime},createdAt);
  }
  f.add('valid','owner','session',{code:'BOOK_ORDER',slug:'__proto__',bookTime:NOW});
  const result=await readChartRejections(f.database,'owner',NOW);
  assert.deepEqual(plain(result),Object.fromEntries([['__proto__',[NOW]]]));
  assert.equal(Object.hasOwn(result,'__proto__'),true,'an unusual slug remains a data key');
  assert.equal(Object.getPrototypeOf(result),null,'missing keys cannot resolve to prototype properties');
  await assert.rejects(readChartRejections(f.database,'owner',NaN),/invalid/);
  f.sqlite.close();
});

test('index creation failure is visible and a later call retries on the same binding',async()=>{
  const f=fixture();f.failCreate();
  await assert.rejects(readChartRejections(f.database,'owner',NOW),/index creation unavailable/);
  assert.deepEqual(plain(await readChartRejections(f.database,'owner',NOW)),{});
  assert.equal(f.creates(),2);f.sqlite.close();
});

test('the committed migration and runtime index creation remain compatible in either order',async()=>{
  const migration=readFileSync(new URL('../drizzle/0004_chart_quote_rejections.sql',import.meta.url),'utf8');
  for(const migrationFirst of [true,false]){
    const f=fixture();
    if(migrationFirst)f.sqlite.exec(migration);
    assert.deepEqual(plain(await readChartRejections(f.database,'owner',NOW)),{});
    f.sqlite.exec(migration);
    const plan=f.sqlite.prepare(`EXPLAIN QUERY PLAN ${f.lastRead()}`).all('owner',NOW-WINDOW,NOW);
    assert.ok(plan.some(row=>String(row.detail).includes('tennis_journal_order_rejections')));
    f.sqlite.close();
  }
});

test('the migrated partial index is compatible with the runtime lookup',async()=>{
  const f=fixture();
  f.sqlite.exec(`CREATE INDEX tennis_journal_order_rejections ON tennis_journal(owner_id,created_at)
    WHERE "tennis_journal"."kind"='decision' AND json_extract("tennis_journal"."value",'$.code')='BOOK_ORDER'`);
  f.add('rejected','owner','old-session',{code:'BOOK_ORDER',slug:'game',bookTime:NOW-100});
  assert.deepEqual(plain(await readChartRejections(f.database,'owner',NOW)),{game:[NOW-100]});
  const plan=f.sqlite.prepare(`EXPLAIN QUERY PLAN ${f.lastRead()}`).all('owner',NOW-WINDOW,NOW);
  assert.ok(plan.some(row=>String(row.detail).includes('tennis_journal_order_rejections')),JSON.stringify(plan));
  f.sqlite.close();
});

test('history SQL omits rejected times before its 600-point limit while retaining raw rows',async()=>{
  const f=fixture();
  const insert=f.sqlite.prepare('INSERT INTO tennis_observations VALUES(?,?,?,?)');
  for(let i=0;i<1201;i++){
    const time=NOW-1201+i;
    insert.run(`game:${time}`,'game',time,JSON.stringify({book:{bids:[{price:.4}],asks:[{price:.41}]},market:{score:null,period:null,contextUpdatedAt:null}}));
    if(i%2===0)f.add(`reject:${i}`,'owner','old-session',{code:'BOOK_ORDER',slug:'game',bookTime:time},time);
  }
  const rejected=(await readChartRejections(f.database,'owner',NOW)).game;
  assert.equal(rejected.length,601);
  const rows=f.sqlite.prepare(CHART_HISTORY_SQL).all('game',NOW-WINDOW,JSON.stringify(rejected)) as {time:number}[];
  assert.equal(rows.length,600);
  assert.ok(rows.every(row=>!rejected.includes(row.time)));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM tennis_observations').get()?.count,1201);
  f.sqlite.close();
});

test('a hung request cannot poison another request on the same D1 binding',async()=>{
  const f=fixture(),firstCreate=f.pauseCreate();
  f.add('rejected','owner','session',{code:'BOOK_ORDER',slug:'game',bookTime:NOW-100});
  const first=readChartRejections(f.database,'owner',NOW);
  const cancelled=assert.rejects(first,/first request disconnected/);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const second=await Promise.race([
      readChartRejections(f.database,'owner',NOW),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Second request reused a hung first-request promise.')),250);}),
    ]);
    assert.deepEqual(plain(second),{game:[NOW-100]});
    assert.equal(f.creates(),2,'the second request issues its own CREATE INDEX');
  }finally{
    if(timer)clearTimeout(timer);
    firstCreate.reject(new Error('first request disconnected'));
    await cancelled;
  }
  assert.deepEqual(plain(await readChartRejections(f.database,'owner',NOW)),{game:[NOW-100]});
  assert.equal(f.creates(),2,'a late failure must not erase another request\'s completed index');
  f.sqlite.close();
});