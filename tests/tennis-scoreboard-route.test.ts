import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SCORE_OWNER as OWNER,resetScoreRoute,state} from './helpers/tennis-scoreboard-route-fixture.ts';
import type {TennisMarket} from '../lib/tennis/types';

const root=fileURLToPath(new URL('../',import.meta.url)),fixture=new URL('./helpers/tennis-scoreboard-route-fixture.ts',import.meta.url).href;
const mocks=['cloudflare:workers','@/lib/server/storage','@/lib/server/request-budget','@/lib/server/polymarket','@/lib/runner/sites-proxy'];
const hooks=registerHooks({resolve(specifier,context,next){
  if(mocks.includes(specifier))return {url:fixture,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve(root,specifier.slice(2)+'.ts')).href,shortCircuit:true};
  if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const candidate=resolve(dirname(fileURLToPath(context.parentURL)),specifier);if(!existsSync(candidate)&&existsSync(candidate+'.ts'))return {url:pathToFileURL(candidate+'.ts').href,shortCircuit:true};}
  return next(specifier,context);
}});
const {GET}=await import('../app/api/tennis/scoreboard/route.ts');hooks.deregister();
const request=(slug:string,options:{owner?:string|null;origin?:string;botId?:string;signal?:AbortSignal}={})=>GET(new Request(`https://test.invalid/api/tennis/scoreboard?slug=${encodeURIComponent(slug)}&botId=${options.botId??'tennis'}`,{signal:options.signal,headers:{origin:options.origin??'https://test.invalid',...(options.owner===null?{}:{'oai-authenticated-user-id':options.owner??OWNER})}}));
const body=(response:Response)=>response.json() as Promise<{market:TennisMarket;successfulCheckAt:number|null;error:string|null;cacheHit:boolean}>;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('selected tennis scoreboard checks owner, origin and bot before looking up a public source',async()=>{
  const market=resetScoreRoute();assert.equal((await request(market.slug,{owner:null})).status,401);assert.equal((await request(market.slug,{origin:'https://other.invalid'})).status,403);assert.equal((await request(market.slug,{botId:'other'})).status,400);assert.equal(state.sql.length,0);assert.equal(state.sourceIds.length,0);
  state.runnerOwner='different-owner-0001';assert.equal((await request(market.slug)).status,403);assert.equal(state.sourceIds.length,0);
});
test('verified tennis match returns mapped scoreboard through five-second cache without changing the account or quotes',async()=>{
  const market=resetScoreRoute(),before=structuredClone(state.account),response=await request(market.slug);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const first=await body(response);assert.equal(first.error,null);assert.equal(first.market.tennis?.serving,'NO');assert.deepEqual(first.market.tennis?.games,{yes:0,no:3});assert.equal(first.market.quoteObservedAt,market.quoteObservedAt);assert.deepEqual(first.market.history,[]);
  const again=await body(await request(market.slug));assert.equal(again.cacheHit,true);assert.equal(again.successfulCheckAt,first.successfulCheckAt);assert.deepEqual(state.sourceIds,['136204']);assert.deepEqual(state.account,before);
  assert.ok(state.sql.every(sql=>sql.startsWith('SELECT ')||sql.startsWith('INSERT INTO cache')));assert.ok(state.writes.every(key=>key.startsWith('tennis:scoreboard:v1:')));
});
test('unknown or other-bot matches and missing accounts cannot trigger arbitrary event requests or initialize an account',async()=>{
  const market=resetScoreRoute();assert.equal((await request('unknown')).status,404);assert.equal((await request('../escape')).status,400);assert.equal((await request(market.slug,{botId:'football'})).status,404);assert.equal(state.sourceIds.length,0);
  state.accountExists=false;assert.equal((await request(market.slug)).status,404);assert.ok(state.sql.every(sql=>sql.startsWith('SELECT ')));assert.equal(state.sourceIds.length,0);
});
test('held or pending tennis remains selectable when discovery no longer lists the game',async()=>{
  for(const source of ['held','pending'] as const){
    const market=resetScoreRoute();state.cache.delete(`tennis:verified:${market.slug}`);state.account.config.leagues=['CFB'];
    if(source==='held')state.account.positions=[{id:'held',slug:market.slug,status:'open',market,lastContext:market}] as typeof state.account.positions;
    else state.account.pending={slug:market.slug,market} as NonNullable<typeof state.account.pending>;
    assert.equal((await request(market.slug,{botId:'football'})).status,200);assert.deepEqual(state.sourceIds,['136204']);
  }
});
test('provider failure preserves last-known scoreboard and check times without modifying accounting',async()=>{
  const market=resetScoreRoute(),before=structuredClone(state.account);state.sourceError=new Error('Provider backoff');const response=await request(market.slug);assert.equal(response.status,200);
  const value=await body(response);assert.equal(value.error,'Provider backoff');assert.equal(value.successfulCheckAt,null);assert.equal(value.market.observedAt,market.observedAt);assert.equal(value.market.contextUpdatedAt,market.contextUpdatedAt);assert.deepEqual(state.account,before);
});
test('whole-route deadline bounds a hanging account read and prevents late provider work',async t=>{
  const market=resetScoreRoute(),gate=deferred();state.sessionGate=gate.promise;t.mock.timers.enable({apis:['setTimeout']});const pending=request(market.slug);t.mock.timers.tick(6500);assert.equal((await pending).status,503);
  gate.resolve();await flush();assert.equal(state.sourceIds.length,0);assert.equal(state.writes.length,0);
});
test('caller cancellation of a scoreboard read ignores late source completion and leaves subsequent requests usable',async()=>{
  const market=resetScoreRoute(),gate=deferred(),controller=new AbortController();state.sourceGate=gate.promise;const pending=request(market.slug,{signal:controller.signal});await flush();assert.equal(state.sourceIds.length,1);controller.abort();assert.equal((await pending).status,503);assert.equal(state.sourceSignal?.aborted,true);
  gate.resolve();await flush();assert.equal(state.writes.length,0);state.sourceGate=null;assert.equal((await request(market.slug)).status,200);assert.equal(state.sourceIds.length,2);
});
test('newer held source context outranks an older catalog copy for the selected match',async()=>{
  const market=resetScoreRoute(),newer={...market,contextUpdatedAt:Date.now()-500,score:'4-6, 0-3:AD-40'};state.account.positions=[{id:'held',slug:market.slug,status:'open',market,lastContext:newer}] as typeof state.account.positions;
  const value=await body(await request(market.slug,{botId:'football'}));assert.ok(value.error);assert.equal(value.market.contextUpdatedAt,newer.contextUpdatedAt);assert.equal(value.market.score,newer.score);
});
test('the real SQLite cache UPSERT prevents rollback and equal-source contradictory facts between reads and writes',async()=>{
  const market=resetScoreRoute();await request(market.slug);const sql=state.sql.find(sql=>sql.startsWith('INSERT INTO cache'))!;
  const key=[...state.cache.keys()].find(key=>key.startsWith('tennis:scoreboard:v1:'))!,record=state.cache.get(key)!.value as {market:TennisMarket};
  const memory=new DatabaseSync(':memory:');try{
    memory.exec('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT,updated INTEGER)');memory.prepare('INSERT INTO cache VALUES(?,?,?)').run(key,JSON.stringify(record),100);
    const olderSource={...record,market:{...record.market,contextUpdatedAt:record.market.contextUpdatedAt!-1,observedAt:record.market.observedAt+100}};
    assert.equal(Number(memory.prepare(sql).run(key,JSON.stringify(olderSource),200).changes),0,'later completion cannot replace newer source facts');
    const olderReceipt={...record,market:{...record.market,observedAt:record.market.observedAt-1}};
    assert.equal(Number(memory.prepare(sql).run(key,JSON.stringify(olderReceipt),200).changes),0,'equal source cannot replace a newer receipt');
    for(const changed of [{score:'4-6, 0-3:AD-40'},{period:'S3'},{live:false},{ended:true},{tennis:{...record.market.tennis,serving:'YES'}},{tennisIdentity:{yesPlayerId:'303',noPlayerId:'202'}}]){
      const contradictory={...record,market:{...record.market,...changed,observedAt:record.market.observedAt+100}};
      assert.equal(Number(memory.prepare(sql).run(key,JSON.stringify(contradictory),200).changes),0,'a newer receipt cannot launder conflicting same-version facts');
    }
    const matching={...record,market:{...record.market,observedAt:record.market.observedAt+100}};
    assert.equal(Number(memory.prepare(sql).run(key,JSON.stringify(matching),200).changes),1,'matching same-version checks can refresh actual receipt');
    const newerSource={...record,market:{...record.market,contextUpdatedAt:record.market.contextUpdatedAt!+1,observedAt:record.market.observedAt+100}};
    assert.equal(Number(memory.prepare(sql).run(key,JSON.stringify(newerSource),200).changes),1);
  }finally{memory.close();}
});
