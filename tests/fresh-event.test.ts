import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFreshFootballEvent} from '../lib/trading/fresh-event.ts';

const now=1_000_000;
const payload={events:[{id:'112943',eventState:{updatedAt:'2026-09-26T22:00:00.000Z',footballState:{driveState:{down:3}}}}]};
const response=(headers:Record<string,string>={})=>Response.json(payload,{headers:{'CF-Cache-Status':'DYNAMIC',...headers}});
function streamResponse(headers:Record<string,string>,status=200,bytes=new TextEncoder().encode('{}')){
  let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);},cancel(){cancelled=true;}});
  return {response:new Response(stream,{status,headers}),cancelled:()=>cancelled};
}

test('fresh event transport uses a numeric ID, compact winner filter and request nonce',async()=>{
  let requested:URL|undefined;
  const result=await fetchFreshFootballEvent('112943',undefined,{now:()=>now,nonce:()=> 'fresh receipt/1',fetcher:async(url,init)=>{
    requested=new URL(url);assert.equal(init.cache,'no-store');assert.ok(init.signal);return response();
  }});
  assert.equal(requested?.origin,'https://gateway.polymarket.us');assert.equal(requested?.pathname,'/v1/events');
  assert.equal(requested?.searchParams.get('id'),'112943');
  assert.equal(requested?.searchParams.get('sportsMarketTypes'),'football_team_full_game_winner');
  assert.equal(requested?.searchParams.get('dugout_read'),'fresh receipt/1');
  assert.deepEqual(result.data,payload);assert.equal(result.receipt.requestedAt,now);assert.equal(result.receipt.receivedAt,now);
});

test('invalid event IDs are rejected before any request',async()=>{
  for(const id of ['','0','112943&limit=20','a','-2','123456789012345678901']){
    await assert.rejects(fetchFreshFootballEvent(id,undefined,{fetcher:async()=>{assert.fail('Must not fetch invalid ID');}}),/numeric/);
  }
});

test('MISS, BYPASS, DYNAMIC, EXPIRED and REVALIDATED with absent or zero Age are accepted without rewriting provider time',async()=>{
  // EXPIRED and REVALIDATED were checked with the origin on this request.
  for(const cache of ['MISS','BYPASS','DYNAMIC','EXPIRED','REVALIDATED'])for(const age of [undefined,'0']){
    let time=now;
    const result=await fetchFreshFootballEvent('112943',undefined,{now:()=>time,fetcher:async()=>{time+=125;return response({'CF-Cache-Status':cache,...(age===undefined?{}:{Age:age})});}});
    assert.deepEqual(result.data,payload);assert.equal(result.receipt.requestedAt,now);assert.equal(result.receipt.receivedAt,now+125);
    assert.equal(result.receipt.cacheStatus,cache);assert.equal(result.receipt.cacheAgeSeconds,age===undefined?null:0);
  }
});

test('cached and unverifiable responses are rejected and their bodies cancelled',async()=>{
  const cases:Record<string,string>[]=[{'CF-Cache-Status':'HIT'},{'CF-Cache-Status':'STALE'},{'CF-Cache-Status':'UPDATING'},{},{'CF-Cache-Status':'MISS',Age:'1'},{'CF-Cache-Status':'DYNAMIC',Age:'bad'},{'CF-Cache-Status':'BYPASS',Age:'-1'}];
  for(const headers of cases){
    const fixture=streamResponse(headers);
    await assert.rejects(fetchFreshFootballEvent('112943',undefined,{fetcher:async()=>fixture.response}),/cached or unverifiable/);
    assert.equal(fixture.cancelled(),true);
  }
});

test('body limit cancels a response as soon as it exceeds one megabyte',async()=>{
  const fixture=streamResponse({'CF-Cache-Status':'MISS'},200,new Uint8Array(1_000_001));
  await assert.rejects(fetchFreshFootballEvent('112943',undefined,{fetcher:async()=>fixture.response}),/oversized/);
  assert.equal(fixture.cancelled(),true);
});

test('429 exposes Retry-After and cancels the response body',async()=>{
  const fixture=streamResponse({'Retry-After':'180'},429);
  await assert.rejects(fetchFreshFootballEvent('112943',undefined,{now:()=>now,fetcher:async()=>fixture.response}),error=>{
    assert.equal((error as {status:number}).status,429);assert.equal((error as {retryAfterMs:number}).retryAfterMs,180_000);return true;
  });
  assert.equal(fixture.cancelled(),true);
});

test('a late 429 after caller cancellation retains provider backoff evidence',async()=>{
  const caller=new AbortController(),fixture=streamResponse({'Retry-After':'180'},429);
  await assert.rejects(fetchFreshFootballEvent('112943',caller.signal,{now:()=>now,fetcher:async()=>{caller.abort();return fixture.response;}}),error=>{
    assert.equal((error as {status:number}).status,429);assert.equal((error as {retryAfterMs:number}).retryAfterMs,180_000);return true;
  });
  assert.equal(fixture.cancelled(),true);
});

test('caller cancellation prevents fetch and discards successful responses arriving afterward',async()=>{
  const before=new AbortController();before.abort();
  await assert.rejects(fetchFreshFootballEvent('112943',before.signal,{fetcher:async()=>{assert.fail('Aborted call must not fetch');}}),{name:'AbortError'});
  const during=new AbortController(),fixture=streamResponse({'CF-Cache-Status':'DYNAMIC'});
  await assert.rejects(fetchFreshFootballEvent('112943',during.signal,{fetcher:async()=>{during.abort();return fixture.response;}}),{name:'AbortError'});
  assert.equal(fixture.cancelled(),true);
});

test('a backward receipt clock is rejected even with an uncached body',async()=>{
  let time=now;
  await assert.rejects(fetchFreshFootballEvent('112943',undefined,{now:()=>time,fetcher:async()=>{time--;return response();}}),/receipt time/);
});
