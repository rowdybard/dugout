import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {reset,state} from './helpers/bot-route-fixture.ts';
import type {BotSession} from '../lib/bot/types';
const body=(response:Response)=>response.json() as Promise<{session:BotSession;error:string}>;

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=new URL('./helpers/bot-route-fixture.ts',import.meta.url).href;
const mocks=['cloudflare:workers','@/lib/server/ingestion','@/lib/bot/server-input','@/lib/server/replay'];
const hooks=registerHooks({resolve(specifier,context,next){
  if(mocks.includes(specifier)||specifier.endsWith('/replay'))return {url:fixture,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve(root,specifier.slice(2)+'.ts')).href,shortCircuit:true};
  if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){
    const candidate=resolve(dirname(fileURLToPath(context.parentURL)),specifier);
    if(!existsSync(candidate)&&existsSync(candidate+'.ts'))return {url:pathToFileURL(candidate+'.ts').href,shortCircuit:true};
  }
  return next(specifier,context);
}});
const {POST,GET}=await import('../app/api/bot/route.ts');
hooks.deregister();
const post=(body:object)=>POST(new Request('https://test.invalid/api/bot',{method:'POST',headers:{origin:'https://test.invalid','content-type':'application/json'},body:JSON.stringify(body)}));

test('real bot route starts a $10 session during total market outage, scans, pauses, resumes and stops',async()=>{
  reset();const response=await post({action:'start',bankroll:10,leagues:['MLB']});
  assert.equal(response.status,200);const initial=await body(response);const sessionId=initial.session.id;
  assert.equal(initial.session.cash,10);assert.equal(initial.session.status,'running');assert.equal(state.catalogCalls,0);assert.equal(state.inputCalls,0);
  const scanned=await body(await post({action:'step',sessionId}));
  assert.equal(scanned.session.cycles,1);assert.equal(scanned.session.cash,10);assert.match(scanned.session.lastReason,/Waiting for data/);
  for(const [action,status] of [['pause','paused'],['resume','running'],['stop','stopped']]){
    const result=await body(await post({action,sessionId}));assert.equal(result.session.status,status);assert.equal(result.session.cash,10);
  }
  const saved=await body(await GET(new Request('https://test.invalid/api/bot')));
  assert.equal(saved.session.id,sessionId);assert.equal(saved.session.status,'stopped');assert.equal(saved.session.positions.length,0);
});
test('duplicate start cannot reset the active bankroll and a wrong-session control cannot change it',async()=>{
  reset();const started=await body(await post({action:'start',bankroll:10,leagues:['MLB']}));
  assert.equal((await post({action:'start',bankroll:25,leagues:['MLB']})).status,400);
  assert.equal((await post({action:'stop',sessionId:crypto.randomUUID()})).status,400);
  const current=await body(await GET(new Request('https://test.invalid/api/bot')));
  assert.equal(current.session.id,started.session.id);assert.equal(current.session.cash,10);assert.equal(current.session.status,'running');
});
test('recorded development data cannot start a current paper bot',async()=>{
  reset();state.replay=true;
  const response=await post({action:'start',bankroll:10,leagues:['MLB']});assert.equal(response.status,400);
  assert.match((await body(response)).error,/recorded development/);assert.equal(state.catalogCalls,0);
});
