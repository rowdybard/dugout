import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSourceBudget} from '../lib/bot/public-source-budget.ts';
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
