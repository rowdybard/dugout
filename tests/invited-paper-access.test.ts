import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
import type {TennisSession} from '../lib/tennis/types';

const OWNER='synthetic-owner-0001',CUSTOMER='synthetic-customer-0002',root=fileURLToPath(new URL('../',import.meta.url)),external=createRequire(import.meta.url);
type Route={GET:(request:Request)=>Promise<Response>;POST:(request:Request)=>Promise<Response>};

function fixture(pin:string|undefined=OWNER){
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL);CREATE TABLE profiles(id TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL);');
  for(const file of ['0003_mixed_vulcan.sql','0005_useful_jimmy_woo.sql'])sql.exec(readFileSync(resolve(root,'drizzle',file),'utf8'));
  let reads=0,writes=0,providerCalls=0;
  function prepare(query:string){let args:unknown[]=[];return {query,
    bind(...values:unknown[]){args=values;return this;},
    async first(){reads++;return sql.prepare(query).get(...args as never[])??null;},
    async all(){reads++;return {results:sql.prepare(query).all(...args as never[]),success:true};},
    async run(){const changes=Number(sql.prepare(query).run(...args as never[]).changes);writes+=changes;return {success:true,meta:{changes}};},
  };}
  const database={prepare,async batch(statements:ReturnType<typeof prepare>[]){sql.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await(statement.query.startsWith('SELECT')?statement.all():statement.run()));sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  const env={DB:database,DUGOUT_OWNER_ID:pin as string|undefined,DUGOUT_RUNNER_URL:'https://synthetic.example.workers.dev',DUGOUT_RUNNER_SECRET:'synthetic-only-secret-with-at-least-32-characters',ANTHROPIC_API_KEY:'synthetic-never-send-this'};
  const modules=new Map<string,{exports:unknown}>();
  function load(filename:string):unknown{
    filename=resolve(filename);const cached=modules.get(filename);if(cached)return cached.exports;
    const normalized=filename.replaceAll('\\','/');
    if(normalized.endsWith('/lib/market/scanner.ts'))return {DEFAULT_CONFIG:{}};
    if(normalized.endsWith('/lib/tennis/server-priority-context.ts'))return {
      async loadServerPriorityContext(){providerCalls++;throw new Error('No fixture game report');},
    };
    if(normalized.endsWith('/lib/tennis/data.ts'))return {
      async getTennisCatalog(){providerCalls++;return {markets:[],updatedAt:Date.now(),errors:[]};},
      async getTennisMarket(){providerCalls++;throw new Error('No fixture market');},
      async loadTennisInput(){providerCalls++;throw new Error('No fixture book');},
    };
    const moduleObject={exports:{}};modules.set(filename,moduleObject);
    const source=ts.transpileModule(readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    new Function('require','module','exports',source)((specifier:string)=>{
      if(specifier==='cloudflare:workers')return {env,waitUntil:(task:Promise<unknown>)=>{void task.catch(()=>{});}};
      if(specifier.startsWith('@/')||specifier.startsWith('.')){
        let child=specifier.startsWith('@/')?resolve(root,specifier.slice(2)):resolve(dirname(filename),specifier);
        if(!existsSync(child))child+='.ts';return load(child);
      }
      return external(specifier);
    },moduleObject,moduleObject.exports);
    return moduleObject.exports;
  }
  return {sql,env,database,close:()=>sql.close(),reads:()=>reads,writes:()=>writes,providerCalls:()=>providerCalls,
    session:load(resolve(root,'app/api/tennis/session/route.ts')) as Route,
    advisor:load(resolve(root,'app/api/tennis/advisor/route.ts')) as Route,
    runner:load(resolve(root,'app/api/tennis/runner/route.ts')) as Route};
}
const request=(owner:string|null,path:string,body?:unknown)=>new Request('https://dugout.invalid/api/tennis/'+path,{method:body===undefined?'GET':'POST',headers:{origin:'https://dugout.invalid',...(owner?{'oai-authenticated-user-id':owner}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
const account=async(response:Response)=>{assert.equal(response.status,200);return response.json() as Promise<{session:TennisSession;runtime:{mode:string}}>};

test('invited customer receives an independent browser paper account and isolated history',async(t)=>{
  const f=fixture();t.after(f.close);let outbound=0;t.mock.method(globalThis,'fetch',async()=>{outbound++;throw new Error('No runner or paid API calls allowed');});
  const owner=await account(await f.session.GET(request(OWNER,'session'))),customer=await account(await f.session.GET(request(CUSTOMER,'session')));
  assert.equal(owner.session.cash,100);assert.equal(customer.session.cash,100);assert.notEqual(customer.session.id,owner.session.id);assert.equal(customer.runtime.mode,'browser');
  const reset=await account(await f.session.POST(request(CUSTOMER,'session',{action:'reset',bankroll:75,commandId:crypto.randomUUID()})));
  assert.equal(reset.session.cash,75);assert.equal(reset.runtime.mode,'browser');
  const started=await account(await f.session.POST(request(CUSTOMER,'session',{action:'start',commandId:crypto.randomUUID(),runForMs:60_000})));
  assert.equal(started.session.status,'running');
  const paused=await account(await f.session.POST(request(CUSTOMER,'session',{action:'pause',commandId:crypto.randomUUID()})));assert.equal(paused.session.status,'paused');
  const unchanged=await account(await f.session.GET(request(OWNER,'session')));assert.equal(unchanged.session.cash,100);assert.equal(unchanged.session.id,owner.session.id);assert.deepEqual(unchanged.session.ledger,[]);
  const exported=await(await f.session.GET(request(CUSTOMER,'session?export=1'))).json() as {session:TennisSession;records:{id:string}[]};
  assert.equal(exported.session.cash,75);assert.ok(exported.records.length>0);assert.ok(exported.records.every(row=>row.id.startsWith(CUSTOMER+':')));
  const ownerExport=await(await f.session.GET(request(OWNER,'session?export=1'))).json() as {records:unknown[]};assert.deepEqual(ownerExport.records,[]);
  assert.equal(outbound,0);assert.equal(f.providerCalls(),0);
});

test('customer migration status is ineligible and every migration action rejects before mutation',async(t)=>{
  const f=fixture();t.after(f.close);t.mock.method(globalThis,'fetch',async()=>{assert.fail('Customer must not contact owner runner');});
  await f.session.GET(request(CUSTOMER,'session'));
  await f.session.POST(request(CUSTOMER,'session',{action:'start',commandId:crypto.randomUUID()}));
  const before=f.sql.prepare('SELECT value,revision FROM tennis_sessions WHERE owner_id=?').get(CUSTOMER),writes=f.writes();
  const status=await(await f.runner.GET(request(CUSTOMER,'runner'))).json() as {eligible:boolean;configured:boolean;canPrepare:boolean;mode:string};
  assert.deepEqual(status,{eligible:false,configured:false,mode:'browser',phase:null,canPrepare:false,revision:0,progress:null,error:null});
  for(const action of ['prepare','advance','activate']){assert.equal((await f.runner.POST(request(CUSTOMER,'runner',{action}))).status,403);}
  assert.equal(f.writes(),writes);assert.deepEqual(f.sql.prepare('SELECT value,revision FROM tennis_sessions WHERE owner_id=?').get(CUSTOMER),before);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM tennis_runner_owners').get()?.n,0);
  assert.equal((await account(await f.session.GET(request(CUSTOMER,'session')))).session.status,'running');
});

test('missing pin fails closed for owner-funded extras but customer paper account still works',async(t)=>{
  const f=fixture();f.env.DUGOUT_OWNER_ID=undefined;t.after(f.close);
  await f.session.GET(request(CUSTOMER,'session'));const writes=f.writes();
  const status=await(await f.runner.GET(request(OWNER,'runner'))).json() as {eligible:boolean;canPrepare:boolean};assert.equal(status.eligible,false);assert.equal(status.canPrepare,false);
  assert.equal((await f.runner.POST(request(OWNER,'runner',{action:'prepare'}))).status,403);
  assert.equal((await f.advisor.POST(request(OWNER,'advisor',{action:'send',requestId:crypto.randomUUID(),message:'Hi'}))).status,403);
  assert.equal(f.writes(),writes);assert.equal((await account(await f.session.GET(request(CUSTOMER,'session')))).session.cash,100);
});

test('customer adviser GET is disabled and POST cannot read chat, reserve allowance or call Claude',async(t)=>{
  const f=fixture();t.after(f.close);let outbound=0;t.mock.method(globalThis,'fetch',async()=>{outbound++;assert.fail('No paid requests');});
  const reads=f.reads(),writes=f.writes();
  const status=await f.advisor.GET(request(CUSTOMER,'advisor'));assert.equal(status.status,200);assert.deepEqual(await status.json(),{enabled:false,configured:false});
  for(const body of [{action:'send',requestId:crypto.randomUUID(),message:'Hi'},{action:'memory',memory:'Customer notes'}])assert.equal((await f.advisor.POST(request(CUSTOMER,'advisor',body))).status,403);
  assert.equal(f.reads(),reads);assert.equal(f.writes(),writes);assert.equal(outbound,0);
  assert.equal((await f.advisor.GET(request(null,'advisor'))).status,401);assert.equal((await f.advisor.POST(request(null,'advisor',{action:'memory',memory:'Missing owner'}))).status,401);
});

test('matching owner keeps adviser reads and memory plus background setup eligibility',async(t)=>{
  const f=fixture();t.after(f.close);t.mock.method(globalThis,'fetch',async()=>{assert.fail('Owner capability checks must not call Claude');});
  await f.session.GET(request(OWNER,'session'));
  const status=await(await f.runner.GET(request(OWNER,'runner'))).json() as {eligible:boolean;canPrepare:boolean};assert.equal(status.eligible,true);assert.equal(status.canPrepare,true);
  const advisor=await(await f.advisor.GET(request(OWNER,'advisor'))).json() as {enabled:boolean;configured:boolean;messagesRemaining:number};assert.equal(advisor.enabled,true);assert.equal(advisor.configured,true);assert.equal(advisor.messagesRemaining,20);
  assert.equal((await f.advisor.POST(request(OWNER,'advisor',{action:'memory',memory:'Owner-only notes'}))).status,200);
  assert.equal(f.sql.prepare('SELECT value FROM cache WHERE key=?').get('advisor:memory:'+OWNER)?.value,'Owner-only notes');
  assert.equal(f.sql.prepare('SELECT value FROM cache WHERE key=?').get('advisor:allowance:v1'),undefined);
  assert.equal((await f.runner.POST(request(OWNER,'runner',{action:'prepare'}))).status,200);
  assert.equal(f.sql.prepare('SELECT mode FROM tennis_runner_owners WHERE owner_id=?').get(OWNER)?.mode,'frozen');
  f.env.DUGOUT_OWNER_ID=undefined;
  const revoked=await(await f.runner.GET(request(OWNER,'runner'))).json() as {eligible:boolean;mode:string};assert.equal(revoked.eligible,false);assert.equal(revoked.mode,'migrating');
  assert.equal((await f.session.POST(request(OWNER,'session',{action:'pause',commandId:crypto.randomUUID()}))).status,409);
});
