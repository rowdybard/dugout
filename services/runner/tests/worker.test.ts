import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {signRunnerRequest} from '../../../lib/runner/protocol.ts';
import {active,OWNER,EPOCH,NOW,SECRET,input} from './helpers.ts';
import type {InputAdapter} from '../src/input-adapter';
import type {RunnerStore} from '../src/store';

// Load the actual Worker entry with only the runtime base class substituted.
// All reducer, signing, SQL transactions and request dispatch remain real.
const filename=fileURLToPath(new URL('../src/worker.ts',import.meta.url)),requireFromWorker=createRequire(filename);
class MockDO {ctx:unknown;env:unknown;constructor(ctx:unknown,env:unknown){this.ctx=ctx;this.env=env;}}
const moduleObject={exports:{}};
new Function('require','module','exports',ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
  (id:string)=>id==='cloudflare:workers'?{DurableObject:MockDO}:requireFromWorker(id),moduleObject,moduleObject.exports);
type TestDO={fetch(request:Request):Promise<Response>;alarm():Promise<void>;store:RunnerStore;adapter:InputAdapter};
const worker=moduleObject.exports as {OwnerPaperRunner:new(ctx:unknown,env:unknown)=>TestDO;default:{fetch(request:Request,env:unknown):Promise<Response>}};
async function setup(){const fixture=await active();let alarm:number|null=null;let writes=0;const storage={...fixture.storage,getAlarm:async()=>alarm,setAlarm:async(value:number)=>{alarm=value;writes++;},deleteAlarm:async()=>{alarm=null;writes++;}};
  const env={RUNNER_OWNER_ID:OWNER,RUNNER_HMAC_SECRET:SECRET,RUNNER_ENGINE_VERSION:'synthetic-build'},instance=new worker.OwnerPaperRunner({storage,waitUntil:()=>{}},env);
  return {...fixture,instance,env,alarm:()=>alarm,writes:()=>writes};}
async function request(instance:TestDO,path:string,value?:unknown){const body=value===undefined?'':JSON.stringify(value),url='https://runner.invalid'+path,method=value===undefined?'GET':'POST';return instance.fetch(new Request(url,{method,headers:await signRunnerRequest(SECRET,url,method,body,OWNER,EPOCH),...(body?{body}:{})}));}

test('Worker rejects unsigned controls before selecting any object',async()=>{
  let touched=false;const env={RUNNER_OWNER_ID:OWNER,RUNNER_HMAC_SECRET:SECRET,PAPER_RUNNERS:{idFromName(){touched=true;throw new Error('must not route');}}};
  assert.equal((await worker.default.fetch(new Request('https://runner.invalid/v1/state'),env)).status,401);assert.equal(touched,false);
});
test('signed resume arms recovery before provider I/O, then engine persists and next alarm remains scheduled',async(t)=>{
  const f=await setup();let now=NOW+2000;t.mock.method(Date,'now',()=>now);
  assert.equal((await request(f.instance,'/v1/command',{command:{action:'resume',commandId:'alarm-resume'}})).status,200);assert.equal(f.alarm(),now+2500);
  now+=4000;let called=false;f.instance.adapter={close(){},health:()=>({updatedAt:now,state:'rest',message:'Synthetic book'}),async gather(){assert.equal(f.alarm(),now+10000);called=true;return {inputs:[input(now)],failures:[]};}};
  await f.instance.alarm();assert.equal(called,true);assert.equal(f.instance.store.session()?.lastTickAt,now);assert.ok(f.alarm()!==null);assert.ok(f.writes()>=2);assert.equal(f.instance.store.usage(now).alarmChecks,1);
});
test('provider failure keeps a recovery alarm and paused flat command removes alarms',async(t)=>{
  const f=await setup();let now=NOW+2000;t.mock.method(Date,'now',()=>now);await request(f.instance,'/v1/command',{command:{action:'resume',commandId:'failure-resume'}});
  now+=4000;f.instance.adapter={close(){},health:()=>({updatedAt:now,state:'error',message:'Synthetic unavailable'}),async gather(){throw new Error('Synthetic network failure');}};
  await f.instance.alarm();assert.ok(f.alarm()!==null);assert.equal(f.instance.store.health().state,'error');
  await request(f.instance,'/v1/command',{command:{action:'pause',commandId:'failure-pause'}});assert.equal(f.alarm(),null);
});
test('pause during a slow fetch wins over stale tick completion',async(t)=>{
  const f=await setup();const now=NOW+2000;t.mock.method(Date,'now',()=>now);await request(f.instance,'/v1/command',{command:{action:'resume',commandId:'slow-resume'}});
  let release!:(v:{inputs:ReturnType<typeof input>[];failures:string[]})=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;});
  f.instance.adapter={close(){},health:()=>({updatedAt:now,state:'rest',message:'Synthetic'}),gather(){started();return new Promise(r=>{release=r;});}};
  const pending=f.instance.alarm();await ready;await request(f.instance,'/v1/command',{command:{action:'pause',commandId:'slow-pause'}});const revision=f.instance.store.session()?.revision;release({inputs:[input(now)],failures:[]});await pending;
  assert.equal(f.instance.store.session()?.status,'paused');assert.equal(f.instance.store.session()?.revision,revision);assert.equal(f.alarm(),null);
});
test('focused end pauses new entries and credentials never appear in SQL plaintext or exports',async(t)=>{
  const f=await setup();const now=NOW+2000;t.mock.method(Date,'now',()=>now);await request(f.instance,'/v1/command',{command:{action:'resume',commandId:'end-resume'}});
  const ended=input(now);ended.market.ended=true;ended.market.live=false;ended.market.active=false;
  f.instance.adapter={close(){},health:()=>({updatedAt:now,state:'rest',message:'Synthetic final'}),async gather(){return {inputs:[],failures:['Final book unavailable'],endedMarket:ended.market};}};
  await f.instance.alarm();assert.equal(f.instance.store.session()?.status,'paused');assert.equal(f.alarm(),null);assert.match(f.instance.store.session()?.lastReason??'',/focused game ended/);
  const event=f.instance.store.exportPage(null,0,500,now).records.find(r=>r.kind==='control'&&r.value.cause);assert.equal((event?.value.cause as {code:string}).code,'FOCUSED_GAME_ENDED');
  const credentials={keyId:'synthetic-provider-key',secretKey:btoa('x'.repeat(32))};const result=await request(f.instance,'/v1/feed-credentials',credentials);assert.equal(result.status,200);assert.deepEqual(await result.json(),{configured:true,transport:'native-stream'});
  const databaseText=JSON.stringify(f.db.prepare('SELECT * FROM runner_meta').all());assert.ok(!databaseText.includes(credentials.keyId));assert.ok(!databaseText.includes(credentials.secretKey));
  assert.ok(!JSON.stringify(f.instance.store.exportPage(null,0,500,now)).includes('ciphertext'));
});
