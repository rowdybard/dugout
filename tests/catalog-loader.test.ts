import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTennisCatalog,type CatalogDependencies,type CatalogLimits} from '../lib/tennis/catalog-loader.ts';
import {initialLeagueDiscovery,type LeagueDiscoveryState} from '../lib/tennis/catalog-discovery.ts';
import type {TennisCatalog,TennisMarket} from '../lib/tennis/types.ts';

type Saved<T>={value:T;updated:number};
type State=LeagueDiscoveryState<TennisMarket>;
const catalogKey='paper-sports:catalog:v3:CFB',stateKey='paper-sports:discovery:v1:CFB';
const limits:CatalogLimits={budgetMs:240,readMs:30,pageMs:80,writeMs:35,cacheTtlMs:0};
const forever=<T>()=>new Promise<T>(()=>{});
function harness(events=Array.from({length:67},(_,i)=>`game-${i}`)){
  const now=Date.now(),old=now-60_000,cache=new Map<string,Saved<unknown>>(),calls:number[]=[];
  const market=(slug:string,observedAt:number)=>({slug,eventId:slug,eventSlug:slug,title:slug,league:'CFB',yesName:'Home',noName:'Away',startTime:new Date(now-1000).toISOString(),observedAt,contextUpdatedAt:observedAt,live:true,ended:false,active:true,score:null,period:null,tournament:null,bid:null,ask:null,price:null,execution:null,history:[]} satisfies TennisMarket);
  const savedMarket=market('saved-game',old);
  const state={...initialLeagueDiscovery<TennisMarket>('CFB'),complete:{'saved-game':savedMarket},status:'complete' as const,lastPageAt:old,completedAt:old};
  cache.set(stateKey,{value:state,updated:old});
  cache.set(catalogKey,{value:{markets:[savedMarket],updatedAt:old,errors:[],discovery:{complete:true,pendingLeagues:[],nextRefreshAt:old}} as TennisCatalog,updated:old});
  const save=async <T>(key:string,value:T,expected:number|null)=>{
    const previous=cache.get(key);if((previous?.updated??null)!==expected)return false;
    cache.set(key,{value:JSON.parse(JSON.stringify(value)),updated:Math.max(Date.now(),(expected??0)+1)});return true;
  };
  const deps:CatalogDependencies={now:Date.now,read:async<T>(key:string)=>structuredClone(cache.get(key)??null) as Saved<T>|null,
    writeLeague:save,writeCatalog:save,eventKey:event=>String(event),normalize:(event,_league,observedAt)=>[market(String(event),observedAt)],
    fetchPage:async(_league,{offset,limit})=>{calls.push(offset);return events.slice(offset,offset+limit);}};
  return {deps,cache,calls,old,market,state:()=>cache.get(stateKey)!.value as State};
}

test('a hung provider returns saved games with their original age, then a healthy request starts independently',async()=>{
  const h=harness(['fresh-game']),fetch=h.deps.fetchPage;h.deps.fetchPage=()=>forever();
  const started=Date.now(),fallback=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.ok(Date.now()-started<600);assert.equal(fallback.discovery?.complete,false);assert.ok(fallback.errors.length);
  assert.equal(fallback.updatedAt,h.old);assert.equal(fallback.markets[0].observedAt,h.old);
  h.deps.fetchPage=fetch;
  const recovered=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.equal(recovered.discovery?.complete,true);assert.deepEqual(recovered.markets.map(m=>m.slug),['fresh-game']);
});

test('cancellation cannot poison the next request or commit a late provider result',async()=>{
  const h=harness(['next-game']),fetch=h.deps.fetchPage;let release!:(rows:string[])=>void;
  h.deps.fetchPage=()=>new Promise(resolve=>{release=resolve;});
  const controller=new AbortController(),first=loadTennisCatalog(['CFB'],h.deps,controller.signal,limits);
  setTimeout(()=>controller.abort(new Error('Request disconnected.')),15);
  const fallback=await first;assert.equal(fallback.discovery?.complete,false);assert.equal(fallback.updatedAt,h.old);
  h.deps.fetchPage=fetch;
  const next=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);assert.equal(next.discovery?.complete,true);
  const checkpoint=JSON.stringify(h.state());release(['late-game']);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(JSON.stringify(h.state()),checkpoint);assert.deepEqual(next.markets.map(m=>m.slug),['next-game']);
});

test('each request saves at most two pages and resumes the JSON checkpoint to finish every market',async()=>{
  const h=harness();const partial=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.deepEqual(h.calls,[0,20]);assert.equal(h.state().nextOffset,40);assert.equal(partial.discovery?.complete,false);
  assert.ok(partial.markets.some(m=>m.slug==='saved-game'));assert.ok(partial.markets.some(m=>m.slug==='game-39'));
  const full=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.deepEqual(h.calls,[0,20,40,60]);assert.equal(full.discovery?.complete,true);assert.equal(full.markets.length,67);
  assert.ok(!full.markets.some(m=>m.slug==='saved-game'),'a complete wave retires old unseen rows');
});

test('hung checkpoint storage is bounded and does not falsely refresh saved ages',async()=>{
  const h=harness(['fresh-game']),write=h.deps.writeLeague;h.deps.writeLeague=()=>forever();
  const started=Date.now(),fallback=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.ok(Date.now()-started<600);assert.equal(fallback.updatedAt,h.old);assert.equal(fallback.discovery?.complete,false);
  assert.deepEqual(fallback.markets.map(m=>m.slug),['saved-game']);h.deps.writeLeague=write;
  const recovered=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);assert.equal(recovered.discovery?.complete,true);
});

test('a lost checkpoint CAS uses the concurrent winner and cannot roll its cursor backward',async()=>{
  const h=harness();h.deps.writeLeague=async(_key,_state,expected)=>{
    const winner={...initialLeagueDiscovery<TennisMarket>('CFB'),status:'scanning' as const,nextOffset:60,lastPageAt:Date.now(),working:{winner:h.market('winner',Date.now())}};
    h.cache.set(stateKey,{value:winner,updated:expected!+1});return false;
  };
  const result=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.equal(h.state().nextOffset,60);assert.ok(result.markets.some(m=>m.slug==='winner'));
  assert.ok(!result.markets.some(m=>m.slug==='game-39'));assert.equal(result.discovery?.complete,false);
});

test('unavailable cache reads are bounded and never present an empty list as complete',async()=>{
  const h=harness();h.deps.read=()=>forever();const started=Date.now();
  const result=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.ok(Date.now()-started<600);assert.deepEqual(result.markets,[]);assert.equal(result.discovery?.complete,false);assert.ok(result.errors.length);
});

test('an unavailable outer catalog write preserves fresh pages but explicitly marks the response incomplete',async()=>{
  const h=harness(['new-game']);h.deps.writeCatalog=()=>forever();
  const result=await loadTennisCatalog(['CFB'],h.deps,undefined,limits);
  assert.deepEqual(result.markets.map(m=>m.slug),['new-game']);assert.equal(result.discovery?.complete,false);assert.ok(result.errors.some(e=>e.includes('timed out')));
});