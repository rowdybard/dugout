import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFreshEspnFootballSummary} from '../lib/trading/fresh-espn-football.ts';

const NOW=1_000_000,payload={meta:{lastUpdatedAt:'2026-10-03T03:14:32Z'}};
function streamResponse(bytes=new TextEncoder().encode('{}'),status=200,headers:Record<string,string>={}){
  let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);},cancel(){cancelled=true;}});
  return {response:new Response(stream,{status,headers}),cancelled:()=>cancelled};
}
test('ESPN summary transport is public, scoped, uncached, bounded and retains actual receipt independently of source time',async()=>{
  let time=NOW;
  const result=await fetchFreshEspnFootballSummary('401868094',undefined,{now:()=>time,nonce:()=> 'synthetic nonce',fetcher:async(url,init)=>{
    const parsed=new URL(url);assert.equal(parsed.origin,'https://site.api.espn.com');assert.equal(parsed.pathname,'/apis/site/v2/sports/football/college-football/summary');assert.equal(parsed.searchParams.get('event'),'401868094');assert.equal(parsed.searchParams.get('dugout_read'),'synthetic nonce');
    assert.equal(init.cache,'no-store');assert.equal(init.redirect,'manual');assert.ok(init.signal);assert.equal(new Headers(init.headers).get('Cache-Control'),'no-cache');time+=125;return Response.json(payload,{headers:{Age:'7'}});
  }});
  assert.deepEqual(result.data,payload);assert.deepEqual(result.receipt,{requestedAt:NOW,receivedAt:NOW+125});
});
test('invalid ESPN identifiers and caller cancellation never dispatch a request',async()=>{
  for(const id of ['','0','../401868094','401868094&other=1','x','123456789012345678901'])await assert.rejects(fetchFreshEspnFootballSummary(id,undefined,{fetcher:async()=>{assert.fail('Must not fetch');}}),/numeric/);
  const caller=new AbortController();caller.abort();await assert.rejects(fetchFreshEspnFootballSummary('401868094',caller.signal,{fetcher:async()=>{assert.fail('Must not fetch');}}),{name:'AbortError'});
});
test('two-megabyte body limit and HTTP errors cancel the response',async()=>{
  const large=streamResponse(new Uint8Array(2_000_001));await assert.rejects(fetchFreshEspnFootballSummary('401868094',undefined,{fetcher:async()=>large.response}),/oversized/);assert.equal(large.cancelled(),true);
  const rate=streamResponse(undefined,429,{'Retry-After':'60'});await assert.rejects(fetchFreshEspnFootballSummary('401868094',undefined,{now:()=>NOW,fetcher:async()=>rate.response}),error=>{assert.equal((error as {status:number}).status,429);assert.equal((error as {retryAfterMs:number}).retryAfterMs,60000);return true;});assert.equal(rate.cancelled(),true);
});
test('timeout bounds a stalled fetch and a stalled body even when the fake provider ignores its abort signal',async()=>{
  // The handles keep Node alive while AbortSignal.timeout (an unref timer) fires.
  const keepAlive=setTimeout(()=>{},1000);
  try{
    await assert.rejects(fetchFreshEspnFootballSummary('401868094',undefined,{timeoutMs:10,fetcher:async()=>new Promise<Response>(()=>{})}),{name:'TimeoutError'});
    const hanging=streamResponse();await assert.rejects(fetchFreshEspnFootballSummary('401868094',undefined,{timeoutMs:10,fetcher:async()=>hanging.response}),{name:'TimeoutError'});assert.equal(hanging.cancelled(),true);
  }finally{clearTimeout(keepAlive);}
});
test('cancelled late responses are discarded, and a backward local receipt clock is rejected',async()=>{
  const caller=new AbortController(),late=streamResponse();await assert.rejects(fetchFreshEspnFootballSummary('401868094',caller.signal,{fetcher:async()=>{caller.abort();return late.response;}}),{name:'AbortError'});assert.equal(late.cancelled(),true);
  let time=NOW;await assert.rejects(fetchFreshEspnFootballSummary('401868094',undefined,{now:()=>time,fetcher:async()=>{time--;return Response.json(payload);}}),/receipt time/);
});
