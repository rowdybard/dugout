import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {OWNER,reset,state,held} from './helpers/tennis-context-route-fixture.ts';
import type {FootballAssessment,TennisMarket} from '../lib/tennis/types';

type ContextResponse={market:TennisMarket;assessment:FootballAssessment;error:string|null;cacheHit:boolean;successfulCheckAt:number|null;checkedAt:number;reportMarket?:never};
const body=(response:Response)=>response.json() as Promise<ContextResponse>;

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=new URL('./helpers/tennis-context-route-fixture.ts',import.meta.url).href;
const mocks=['@/lib/server/storage','@/lib/server/request-budget','@/lib/server/polymarket','@/lib/tennis/server'];
const hooks=registerHooks({resolve(specifier,context,next){
  if(mocks.includes(specifier))return {url:fixture,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve(root,specifier.slice(2)+'.ts')).href,shortCircuit:true};
  if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const candidate=resolve(dirname(fileURLToPath(context.parentURL)),specifier);if(!existsSync(candidate)&&existsSync(candidate+'.ts'))return {url:pathToFileURL(candidate+'.ts').href,shortCircuit:true};}
  return next(specifier,context);
}});
const {GET}=await import('../app/api/tennis/context/route.ts');hooks.deregister();
const request=(slug:string,owner:string|null=OWNER,origin='https://test.invalid')=>GET(new Request(`https://test.invalid/api/tennis/context?slug=${encodeURIComponent(slug)}`,{headers:{origin,...(owner?{'oai-authenticated-user-id':owner}:{})}}));

test('context route requires explicit owner and matching origin before loading an account or source',async()=>{
  const market=reset();assert.equal((await request(market.slug,null)).status,401);assert.equal((await request(market.slug,OWNER,'https://other.invalid')).status,403);assert.equal(state.sessionReads,0);assert.equal(state.paths.length,0);
  state.owner='another-owner-0001';assert.equal((await request(market.slug)).status,403);assert.equal(state.paths.length,0);
});
test('verified selected report uses one direct event request, caches for 3s, and never changes paper accounting',async()=>{
  const market=reset(),before=structuredClone(state.session);const response=await request(market.slug);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const first=await body(response);assert.equal(first.assessment.status,'fresh');assert.equal(first.market.contextUpdatedAt,market.contextUpdatedAt);assert.equal(first.market.football?.possessionTeamId,'1245');assert.equal(first.reportMarket,undefined);assert.equal(typeof first.successfulCheckAt,"number");
  const again=await body(await request(market.slug));assert.equal(again.cacheHit,true);assert.equal(again.successfulCheckAt,first.successfulCheckAt);assert.equal(again.market.observedAt,first.market.observedAt);assert.deepEqual(state.paths,['/v1/events?id=112943&sportsMarketTypes=football_team_full_game_winner']);assert.ok(state.writes.every(key=>key.startsWith('tennis:priority-context:v1:')));assert.deepEqual(state.session,before);
});
test('unknown or unselected markets cannot trigger arbitrary provider lookups; held games survive catalog loss',async()=>{
  const market=reset();assert.equal((await request('unknown')).status,404);assert.equal((await request('../escape')).status,400);state.session.config.leagues=['ATP'];assert.equal((await request(market.slug)).status,404);assert.equal(state.paths.length,0);
  held(market);state.cache.delete(`tennis:verified:${market.slug}`);const response=await request(market.slug);assert.equal(response.status,200);assert.equal((await body(response)).market.slug,market.slug);assert.equal(state.paths.length,1);
});
test('source errors retain original display clocks and mark the report unknown without updating quotes or ledger',async()=>{
  const market=reset(),before=structuredClone(state.session);state.error=new Error('Provider backoff');const response=await request(market.slug);assert.equal(response.status,200);const value=await body(response);assert.equal(value.error,'Provider backoff');assert.equal(value.successfulCheckAt,null);assert.equal(value.assessment.status,'unknown');assert.equal(value.market.observedAt,market.observedAt);assert.equal(value.market.contextUpdatedAt,market.contextUpdatedAt);assert.equal(value.market.quoteObservedAt,market.quoteObservedAt);assert.deepEqual(state.session,before);
});
