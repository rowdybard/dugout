import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSourceBudget,publicRetryAfterMs} from '../lib/bot/public-source-budget.ts';
test('US reads serialize with conservative pacing and a failed read cannot poison the queue',async()=>{
  let now=1000;const calls:number[]=[];
  const budget=createPublicSourceBudget({now:()=>now,delay:async ms=>{now+=ms;}});
  const results=await Promise.allSettled([budget.run(async()=>{calls.push(now);return 1;}),budget.run(async()=>{calls.push(now);throw new Error('Unavailable');}),budget.run(async()=>{calls.push(now);return 3;})]);
  assert.deepEqual(calls,[1000,1750,2500]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[2].status,'fulfilled');
});
test('provider rate limiting blocks queued requests without sending them or exposing raw HTML',async()=>{
  let now=1000,calls=0;const budget=createPublicSourceBudget({now:()=>now,delay:async ms=>{now+=ms;}});
  await assert.rejects(budget.run(async()=>{calls++;throw Object.assign(new Error('<html>Cloudflare 1015</html>'),{status:429,retryAfterMs:180000});}),/Requests paused/);
  await assert.rejects(budget.run(async()=>{calls++;return 1;}),/requested a pause/);assert.equal(calls,1);
  now=181000;assert.equal(await budget.run(async()=>{calls++;return 2;}),2);assert.equal(calls,2);
});
test('HTTP errors are summarized while no quote value is synthesized',async()=>{
  const budget=createPublicSourceBudget();
  await assert.rejects(budget.run(async()=>{throw Object.assign(new Error('<html>private server detail</html>'),{status:503});}),/^Error: Polymarket US returned HTTP 503\. No current quote was accepted\.$/);
});
test('expired work waiting in the public queue is never sent to the provider',async()=>{
  let release!:()=>void,expiredCalls=0;
  const budget=createPublicSourceBudget({spacingMs:0});
  const first=budget.run(()=>new Promise<void>(resolve=>{release=resolve;}));
  await Promise.resolve();
  const controller=new AbortController();
  const expired=budget.run(async()=>{expiredCalls++;},controller.signal);
  controller.abort(new DOMException('Expired','TimeoutError'));release();
  await first;await assert.rejects(expired,{name:'TimeoutError'});
  assert.equal(expiredCalls,0);
  assert.equal(await budget.run(async()=>42),42,'a cancelled waiter must not poison later reads');
});
test('Retry-After preserves seconds and HTTP dates and rejects invalid delays',()=>{
  const now=Date.parse('2026-09-25T22:00:00Z');
  assert.equal(publicRetryAfterMs('180',now),180000);
  assert.equal(publicRetryAfterMs('Fri, 25 Sep 2026 22:03:00 GMT',now),180000);
  assert.equal(publicRetryAfterMs('Fri, 25 Sep 2026 21:59:00 GMT',now),0);
  for(const header of [null,'','bad header','-2','Infinity','9'.repeat(400)])assert.equal(publicRetryAfterMs(header,now),undefined);
});
test('an HTTP-date rate-limit pause is honored beyond the fallback delay',async()=>{
  let now=Date.parse('2026-09-25T22:00:00Z'),calls=0;
  const budget=createPublicSourceBudget({now:()=>now,delay:async ms=>{now+=ms;}});
  await assert.rejects(budget.run(async()=>{calls++;throw Object.assign(new Error('Rate limit'),{status:429,retryAfterMs:publicRetryAfterMs('Fri, 25 Sep 2026 22:03:00 GMT',now)});}),/Requests paused/);
  now+=150000;
  await assert.rejects(budget.run(async()=>{calls++;return 'too early';}),/requested a pause/);
  assert.equal(calls,1);
  now+=30000;
  assert.equal(await budget.run(async()=>{calls++;return 'ready';}),'ready');
  assert.equal(calls,2);
});
