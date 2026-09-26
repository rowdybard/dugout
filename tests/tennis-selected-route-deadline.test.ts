import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {OWNER,reset,state} from './helpers/tennis-context-route-fixture.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=new URL('./helpers/tennis-context-route-fixture.ts',import.meta.url).href;
const mocks=['@/lib/server/storage','@/lib/server/request-budget','@/lib/server/polymarket','@/lib/tennis/server','@/lib/tennis/data'];
const hooks=registerHooks({resolve(specifier,context,next){
  if(mocks.includes(specifier))return {url:fixture,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve(root,specifier.slice(2)+'.ts')).href,shortCircuit:true};
  if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const candidate=resolve(dirname(fileURLToPath(context.parentURL)),specifier);if(!existsSync(candidate)&&existsSync(candidate+'.ts'))return {url:pathToFileURL(candidate+'.ts').href,shortCircuit:true};}
  return next(specifier,context);
}});
const book=await import('../app/api/tennis/book/route.ts'),context=await import('../app/api/tennis/context/route.ts');hooks.deregister();
const request=(name:string,slug:string,signal?:AbortSignal,owner=OWNER)=>new Request(`https://test.invalid/api/tennis/${name}?slug=${slug}`,{signal,headers:{origin:'https://test.invalid','oai-authenticated-user-id':owner}});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

for(const [name,route] of Object.entries({book,context})){
  test(`${name}: whole-route timeout bounds a hanging account preflight`,async t=>{
    const market=reset(),gate=deferred();state.sessionGate=gate.promise;
    t.mock.timers.enable({apis:['setTimeout']});
    const response=route.GET(request(name,market.slug));
    t.mock.timers.tick(6500);const value=await response;
    assert.equal(value.status,503);assert.equal(state.bookCalls,0);assert.equal(state.paths.length,0);
    gate.resolve();await flush();assert.equal(state.bookCalls,0);assert.equal(state.paths.length,0);
  });
  test(`${name}: cancellation while the verified-cache read hangs cannot start a late provider request`,async()=>{
    const market=reset(),gate=deferred(),controller=new AbortController();state.cacheGate=gate.promise;
    const response=route.GET(request(name,market.slug,controller.signal));await flush();
    controller.abort(new DOMException('Client disconnected','AbortError'));
    assert.equal((await response).status,503);gate.resolve();await flush();
    assert.equal(state.paths.length,0);assert.equal(state.bookCalls,0);assert.equal(state.writes.length,0);
  });
  test(`${name}: a timed-out caller does not poison the following owner request`,async()=>{
    const market=reset(),gate=deferred(),controller=new AbortController();state.sessionGate=gate.promise;
    const first=route.GET(request(name,market.slug,controller.signal));controller.abort();assert.equal((await first).status,503);
    state.sessionGate=null;
    assert.equal((await route.GET(request(name,market.slug))).status,200);
    gate.resolve();await flush();assert.equal(name==='book'?state.bookCalls:state.paths.length,1);
  });
}

test('book route retains owner checks and rejects stale quotes after the bounded preflight',async()=>{
  const market=reset(),before=structuredClone(state.session);
  state.owner='another-owner-0001';assert.equal((await book.GET(request('book',market.slug))).status,403);assert.equal(state.bookCalls,0);
  state.owner=OWNER;state.staleBook=true;assert.equal((await book.GET(request('book',market.slug))).status,503);
  assert.deepEqual(state.session,before);
});

test('book route forwards cancellation to an in-flight provider and ignores its late completion',async()=>{
  const market=reset(),gate=deferred(),controller=new AbortController();state.bookGate=gate.promise;
  const response=book.GET(request('book',market.slug,controller.signal));await flush();assert.equal(state.bookCalls,1);
  controller.abort();assert.equal((await response).status,503);assert.equal(state.bookSignal?.aborted,true);
  gate.resolve();await flush();assert.equal(state.writes.length,0);
});