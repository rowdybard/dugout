import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
import {createServerPublicSourceBudget} from '../lib/server/public-source-budget.ts';
import {publicRetryAfterMs} from '../lib/bot/public-source-budget.ts';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function promptly<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Request remained tied to another request’s work.')),1000);})]);}finally{clearTimeout(timer);}}

test('a hung first provider call does not own later requests and abort returns before its I/O settles',async()=>{
  let now=1000;const firstIO=deferred<number>(),controller=new AbortController(),calls:number[]=[];
  const budget=createServerPublicSourceBudget({now:()=>now,delay:async ms=>{now+=ms;}});
  const first=budget.run(()=>{calls.push(now);return firstIO.promise;},controller.signal);
  const rejected=assert.rejects(first,{name:'AbortError'});
  controller.abort(new DOMException('First request disconnected','AbortError'));await promptly(rejected);
  assert.equal(await promptly(budget.run(async()=>{calls.push(now);return 42;})),42);
  assert.deepEqual(calls,[1000,1750]);firstIO.resolve(1);
});

test('an aborted pacing waiter rejects promptly and is never dispatched after the timer finishes',async()=>{
  let now=1000,calls=0;const sleeping=deferred<void>(),entered=deferred<void>();
  const budget=createServerPublicSourceBudget({now:()=>now,delay:()=>{entered.resolve();return sleeping.promise;}});
  await budget.run(async()=>1);
  const controller=new AbortController(),waiting=budget.run(async()=>{calls++;return 2;},controller.signal);
  const rejected=assert.rejects(waiting,{name:'TimeoutError'});await entered.promise;
  controller.abort(new DOMException('Expired before dispatch','TimeoutError'));await promptly(rejected);
  now=1750;sleeping.resolve();await Promise.resolve();await Promise.resolve();assert.equal(calls,0);
  assert.equal(await promptly(budget.run(async()=>3)),3);
});

test('simultaneously waking requests claim distinct 750ms start slots',async()=>{
  let now=1000;const waits:{at:number;done:ReturnType<typeof deferred<void>>}[]=[],calls:number[]=[];
  const budget=createServerPublicSourceBudget({now:()=>now,delay:async ms=>{const done=deferred<void>();waits.push({at:now+ms,done});await done.promise;}});
  await budget.run(async()=>{calls.push(now);});
  const second=budget.run(async()=>{calls.push(now);return 2;}),third=budget.run(async()=>{calls.push(now);return 3;});
  assert.equal(waits.length,2);now=1750;waits[0].done.resolve();waits[1].done.resolve();
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.deepEqual(calls,[1000,1750]);assert.equal(waits.length,3);
  now=2500;waits[2].done.resolve();assert.deepEqual((await Promise.all([second,third])).sort(),[2,3]);assert.deepEqual(calls,[1000,1750,2500]);
});

test('a rate limit received during another request’s pacing wait blocks that request before dispatch',async()=>{
  let now=1000,calls=0;const slow=deferred<number>(),sleeping=deferred<void>();
  const budget=createServerPublicSourceBudget({now:()=>now,delay:()=>sleeping.promise});
  const first=budget.run(()=>slow.promise),limited=assert.rejects(first,/Requests paused/);
  const queued=budget.run(async()=>{calls++;return 2;}),blocked=assert.rejects(queued,/requested a pause/);
  slow.reject(Object.assign(new Error('Provider 429'),{status:429,retryAfterMs:180000}));await limited;
  assert.equal(budget.blockedUntil(),181000);now=1750;sleeping.resolve();await blocked;assert.equal(calls,0);
  now=181000;assert.equal(await budget.run(async()=>7),7);
});

test('provider HTTP errors remain sanitized and inherited backoff never shortens',async()=>{
  let now=1000;const budget=createServerPublicSourceBudget({spacingMs:0,now:()=>now});
  await assert.rejects(budget.run(async()=>{throw Object.assign(new Error('<html>private details</html>'),{status:503});}),/^Error: Polymarket US returned HTTP 503\. No current quote was accepted\.$/);
  budget.deferUntil(10000);budget.deferUntil(5000);assert.equal(budget.blockedUntil(),10000);
  await assert.rejects(budget.run(async()=>1),/requested a pause/);now=10000;assert.equal(await budget.run(async()=>2),2);
});

test('late 429 after caller abort still classifies the original request and retains durable backoff work',async()=>{
  const source=deferred<number>(),controller=new AbortController(),retained:Promise<unknown>[]=[],deadlines:number[]=[];
  const budget=createServerPublicSourceBudget({spacingMs:0,now:()=>1000});
  const first=budget.run(()=>source.promise,controller.signal,{retain:task=>{retained.push(task);},onBackoff:async until=>{deadlines.push(until);}});
  const rejected=assert.rejects(first,{name:'AbortError'});controller.abort(new DOMException('Caller left','AbortError'));await promptly(rejected);
  source.reject(Object.assign(new Error('Provider429'),{status:429,retryAfterMs:180000}));await Promise.all(retained);
  assert.equal(budget.blockedUntil(),181000);assert.deepEqual(deadlines,[181000]);assert.equal(retained.length,1);
  let called=false;await assert.rejects(budget.run(async()=>{called=true;return 2;}),/requested a pause/);assert.equal(called,false);
});

test('actual publicGet retains late 429 persistence and a fresh isolate honors the shared D1 pause',async(t)=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL)');
  t.mock.method(Date,'now',()=>1000);const response=deferred<Response>(),fetchStarted=deferred<void>();let fetches=0;
  t.mock.method(globalThis,'fetch',async()=>{fetches++;fetchStarted.resolve();return response.promise;});
  const database={prepare(query:string){let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async first(){return sql.prepare(query).get(...args as never[])??null;},async run(){return {meta:{changes:Number(sql.prepare(query).run(...args as never[]).changes)}};}};}};
  const retained:Promise<unknown>[]=[];
  function freshIsolate(){
    const filename=fileURLToPath(new URL('../lib/server/polymarket.ts',import.meta.url)),moduleObject={exports:{}};
    const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('require','module','exports',source)((id:string)=>{
      if(id==='./replay')return {replayData:async()=>null};
      if(id==='polymarket-us')return {PolymarketUS:class{}};
      if(id==='./storage')return {db:()=>database};
      if(id==='../bot/public-source-budget')return {publicRetryAfterMs};
      if(id==='./public-source-budget')return {createServerPublicSourceBudget};
      if(id==='cloudflare:workers')return {waitUntil:(task:Promise<unknown>)=>{retained.push(task);}};
      if(id==='../trading/fresh-book')return {};
      throw new Error('Unexpected provider dependency: '+id);
    },moduleObject,moduleObject.exports);
    return moduleObject.exports as {publicGet:(path:string,signal?:AbortSignal)=>Promise<unknown>};
  }
  const first=freshIsolate(),controller=new AbortController(),read=first.publicGet('/v1/example',controller.signal);
  const cancelled=assert.rejects(read,{name:'AbortError'});await fetchStarted.promise;
  controller.abort(new DOMException('Caller disconnected','AbortError'));await promptly(cancelled);
  // Another isolate already observed a longer pause. The late write must use MAX.
  sql.prepare('INSERT INTO cache VALUES(?,?,?)').run('polymarket:backoff','200000',1000);
  response.resolve(new Response('Rate limited',{status:429,headers:{'Retry-After':'180'}}));await Promise.all(retained);
  assert.equal(retained.length,1);assert.equal(sql.prepare('SELECT value FROM cache').get()?.value,'200000');
  await assert.rejects(freshIsolate().publicGet('/v1/another'),/requests are paused/);assert.equal(fetches,1);
});
