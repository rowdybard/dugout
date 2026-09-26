import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFreshMarketBook} from '../lib/trading/fresh-book.ts';
import {freshTennisBook,normalizeTennisBook} from '../lib/tennis/normalize.ts';
import {createPublicSourceBudget} from '../lib/bot/public-source-budget.ts';

const slug='synthetic-winner';
const body=(time:string|null)=>({marketData:{marketSlug:slug,state:'MARKET_STATE_OPEN',transactTime:time,
  bids:[{px:{value:'.465'},qty:'19423.31'}],offers:[{px:{value:'.470'},qty:'6460.07'}]}});

test('fresh fallback uses one nonce request and timestamps the start, not late receipt',async()=>{
  let clock=1000,calls=0;
  const result=await fetchFreshMarketBook(slug,undefined,{now:()=>clock,nonce:()=> 'unique / request',fetcher:async(url,init)=>{
    calls++;assert.equal(new URL(url).searchParams.get('dugout_read'),'unique / request');
    assert.equal(new URL(url).pathname,`/v1/markets/${slug}/book`);assert.equal(init.cache,'no-store');
    clock=6500;return Response.json(body('2026-09-25T01:00:00Z'),{headers:{'CF-Cache-Status':'MISS'}});
  }});
  assert.equal(calls,1);assert.equal(result.receipt.requestedAt,1000);assert.equal(result.receipt.receivedAt,6500);
  assert.equal(freshTennisBook(result.receipt.requestedAt,clock),false);
  assert.equal(normalizeTennisBook(result.data,slug).bids[0].quantity,19423.31);
});

test('CDN cache hits cannot become independent observations even with Age zero or a new transaction time',async()=>{
  for(const [status,age] of [['HIT','17'],['HIT','0'],['STALE','0'],['UPDATING','0'],['MISS','17'],['MISS',''],['MISS','invalid'],['MISS','0.0'],['MISS','-1'],['REVALIDATED',null],['EXPIRED',null],[null,null],['UNKNOWN',null]]){
    let calls=0;const headers=new Headers();if(status!==null)headers.set('CF-Cache-Status',status);if(age!==null)headers.set('Age',age);
    await assert.rejects(()=>fetchFreshMarketBook(slug,undefined,{fetcher:async()=>{calls++;return Response.json(body(new Date().toISOString()),{headers});}}),/cached or unverifiable/);
    assert.equal(calls,1,'a rejected response must not trigger a retry');
  }
});

test('verified origin reads preserve old or absent transaction timestamps without assuming a stale book',async()=>{
  for(const status of ['MISS','BYPASS','DYNAMIC'])for(const time of [null,'2020-01-01T00:00:00Z']){
    const result=await fetchFreshMarketBook(slug,undefined,{fetcher:async()=>Response.json(body(time),{headers:{'CF-Cache-Status':status,Age:'0'}})});
    assert.equal(normalizeTennisBook(result.data,slug).time,time??'');assert.equal(result.receipt.cacheStatus,status);
  }
});

test('aborted requests never return a late book and retain the caller signal',async()=>{
  const controller=new AbortController();
  await assert.rejects(()=>fetchFreshMarketBook(slug,controller.signal,{fetcher:async(_url,init)=>{
    controller.abort();assert.equal(init.signal?.aborted,true);return Response.json(body(null),{headers:{'CF-Cache-Status':'MISS'}});
  }}),{name:'AbortError'});
});

test('HTTP 429 retains provider backoff through the shared request budget',async()=>{
  const budget=createPublicSourceBudget({now:()=>1000,spacingMs:0});let calls=0;
  const request=()=>fetchFreshMarketBook(slug,undefined,{now:()=>1000,fetcher:async()=>{calls++;return new Response('rate limit',{status:429,headers:{'Retry-After':'90'}});}});
  await assert.rejects(()=>budget.run(request),/rate limit/);assert.equal(budget.blockedUntil(),91000);
  await assert.rejects(()=>budget.run(request),/requested a pause/);assert.equal(calls,1);
});

test('oversized source responses fail before a book can be used',async()=>{
  await assert.rejects(()=>fetchFreshMarketBook(slug,undefined,{fetcher:async()=>new Response('x'.repeat(1_000_001),{headers:{'CF-Cache-Status':'MISS'}})}),/oversized/);
});
