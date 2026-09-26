import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';

type Row={value:string;updated:number};
type StorageModule={cached:<T>(key:string,ttl:number,load:()=>Promise<T>)=>Promise<T>;readCached:<T>(key:string)=>Promise<{value:T;updated:number}|null>};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function promptly<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('The independent request waited for another request’s I/O.')),1000);})]);}finally{clearTimeout(timer);}}

function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL)');let writes=0;
  const rows={set:(key:string,row:Row)=>sql.prepare('INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(key,row.value,row.updated),get:(key:string)=>sql.prepare('SELECT value,updated FROM cache WHERE key=?').get(key) as Row|undefined};
  let stalledWrite:{entered:ReturnType<typeof deferred<void>>;completion:ReturnType<typeof deferred<void>>}|null=null;
  function prepare(query:string){let args:unknown[]=[];return {
    bind(...values:unknown[]){args=values;return this;},
    async first(){return sql.prepare(query).get(...args as never[])??null;},
    async all(){return {results:sql.prepare(query).all(...args as never[]),success:true};},
    async run(){
      if(stalledWrite){const gate=stalledWrite;stalledWrite=null;gate.entered.resolve();await gate.completion.promise;}
      const changes=Number(sql.prepare(query).run(...args as never[]).changes);writes+=changes;return {success:true,meta:{changes}};
    },query,
  };}
  const database={prepare,async batch(statements:ReturnType<typeof prepare>[]){sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await(statement.query.startsWith('SELECT')?statement.all():statement.run()));sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  // Execute the actual production module with only external bindings replaced.
  // Each fixture represents one isolate, so concurrent calls share its globals.
  const filename=fileURLToPath(new URL('../lib/server/storage.ts',import.meta.url)),moduleObject={exports:{}};
  const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',source)((id:string)=>{
    if(id==='cloudflare:workers')return {env:{DB:database}};
    if(id==='@/lib/market/scanner')return {DEFAULT_CONFIG:{}};
    throw new Error('Unexpected production dependency: '+id);
  },moduleObject,moduleObject.exports);
  return {api:moduleObject.exports as StorageModule,rows,close:()=>sql.close(),writes:()=>writes,stallWrite:()=>{
    const gate={entered:deferred<void>(),completion:deferred<void>()};stalledWrite=gate;return gate;
  }};
}

test('a second request for the same key loads independently while the first loader is hung',async(t)=>{
  const f=fixture(),started=deferred<void>(),firstLoad=deferred<{observedAt:number}>();
  t.after(f.close);
  const first=f.api.cached('book:one',1000,()=>{started.resolve();return firstLoad.promise;});
  const firstFailed=assert.rejects(first,/abandoned first loader/);await started.promise;
  try{
    const second=await promptly(f.api.cached('book:one',1000,async()=>({observedAt:2000})));
    assert.deepEqual(second,{observedAt:2000});assert.equal(f.writes(),1);
  }finally{firstLoad.reject(new Error('abandoned first loader'));await firstFailed;}
});

test('a stranded D1 write cannot make later requests adopt another request’s pending promise',async(t)=>{
  const f=fixture(),gate=f.stallWrite();
  t.after(f.close);
  const first=f.api.cached('metadata:one',1000,async()=>({observedAt:1000}));
  const firstFailed=assert.rejects(first,/request ended during persistence/);await gate.entered.promise;
  try{
    const second=await promptly(f.api.cached('metadata:one',1000,async()=>({observedAt:2000})));
    assert.deepEqual(second,{observedAt:2000});assert.equal(f.writes(),1);
    assert.deepEqual((await f.api.readCached('metadata:one'))?.value,{observedAt:2000});
  }finally{gate.completion.reject(new Error('request ended during persistence'));await firstFailed;}
});

test('fresh cache hits keep the stored timestamp and observation time; TTL expiry still reloads',async(t)=>{
  const f=fixture();let now=1999,calls=0;t.mock.method(Date,'now',()=>now);
  t.after(f.close);
  f.rows.set('book:cached',{value:JSON.stringify({observedAt:17}),updated:1000});
  const load=async()=>{calls++;return {observedAt:1500};};
  assert.deepEqual(await f.api.cached('book:cached',1000,load),{observedAt:17});
  assert.equal(calls,0);assert.equal(f.writes(),0);assert.equal(f.rows.get('book:cached')?.updated,1000);
  now=2000;assert.deepEqual(await f.api.cached('book:cached',1000,load),{observedAt:1500});
  assert.equal(calls,1);assert.equal(f.rows.get('book:cached')?.updated,2000);
});

test('large cached values still round-trip through the existing generation/chunk format',async(t)=>{
  const f=fixture();t.mock.method(Date,'now',()=>3000);
  t.after(f.close);
  const value={observedAt:123,text:'🎾'.repeat(250000)};
  assert.equal(await f.api.cached('large',1000,async()=>value),value);
  const manifest=JSON.parse(f.rows.get('large')!.value) as {__chunks:number;generation:string};
  assert.ok(manifest.__chunks>1);assert.ok(manifest.generation);
  assert.deepEqual(await f.api.readCached('large'),{value,updated:3000});
  const beforeWrites=f.writes();assert.deepEqual(await f.api.cached('large',1000,async()=>{throw new Error('Fresh chunks must be reused');}),value);
  assert.equal(f.writes(),beforeWrites);assert.equal(f.rows.get('large')?.updated,3000);
});

test('reversed independent loads cannot overwrite or rejuvenate a winning insert or expired update',async(t)=>{
  let now=2000;t.mock.method(Date,'now',()=>now);
  for(const seeded of [false,true]){
    const f=fixture();t.after(f.close);if(seeded)f.rows.set('race',{value:JSON.stringify({observedAt:50}),updated:500});
    const entered=deferred<void>(),oldLoad=deferred<{observedAt:number}>();
    const first=f.api.cached('race',1000,()=>{entered.resolve();return oldLoad.promise;});await entered.promise;
    const winner={observedAt:1900};assert.deepEqual(await f.api.cached('race',1000,async()=>winner),winner);
    const saved={...f.rows.get('race')!},writes=f.writes();now=4000;oldLoad.resolve({observedAt:1000});
    assert.deepEqual(await first,winner);assert.deepEqual(await f.api.readCached('race'),{value:winner,updated:2000});
    assert.deepEqual({...f.rows.get('race')},saved);assert.equal(f.writes(),writes);now=2000;
  }
});

test('same-millisecond updates compare stored contents, and losing chunk generations cannot replace the manifest',async(t)=>{
  t.mock.method(Date,'now',()=>5000);
  for(const chunked of [false,true]){
    const f=fixture();t.after(f.close);f.rows.set('race',{value:JSON.stringify({observedAt:0}),updated:5000});
    const entered=deferred<void>(),oldLoad=deferred<{observedAt:number;text:string}>();
    const first=f.api.cached('race',0,()=>{entered.resolve();return oldLoad.promise;});await entered.promise;
    const newer={observedAt:4900,text:chunked?'N'.repeat(900000):'new'};
    await f.api.cached('race',0,async()=>newer);const manifest={...f.rows.get('race')!},writes=f.writes();
    oldLoad.resolve({observedAt:4500,text:chunked?'O'.repeat(900000):'old'});
    assert.deepEqual(await first,newer);assert.deepEqual({...f.rows.get('race')},manifest);assert.equal(f.writes(),writes);
    assert.deepEqual(await f.api.readCached('race'),{value:newer,updated:5000});
  }
});
