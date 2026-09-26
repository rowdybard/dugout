import test from 'node:test';
import assert from 'node:assert/strict';
import {marketWithWatchedBook,marketWithWatchedContext,watchedBookIssue} from '../lib/tennis/chart-data.ts';
import type {TennisInput,TennisMarket,TennisSession} from '../lib/tennis/types';

const market=()=>({slug:'selected-game-26',eventId:'event-26',league:'CFB',yesName:'A',noName:'B',observedAt:1000,contextUpdatedAt:500,score:'7-0',period:'Q1',history:[],bid:.39,ask:.41,price:.4,quoteSource:'CATALOG'} as unknown as TennisMarket);
const input=():TennisInput=>({market:{...market(),observedAt:9900,score:'99-99'},book:{bids:[{price:.49,quantity:10}],asks:[{price:.50,quantity:10}],state:'MARKET_STATE_OPEN',time:new Date(9500).toISOString()},receivedAt:9800,sourceTime:9500,source:'REST',restReceipt:{requestedAt:9800,receivedAt:9900,cacheStatus:'MISS',cacheAgeSeconds:null}});
const session=()=>({config:{maxBookAgeMs:5000},bookSourceTimes:{'selected-game-26':9400},quotes:{},decisions:[],histories:{}} as unknown as TennisSession);

test('priority field reports retain book and chart evidence and ignore late or wrong-game reports',()=>{
  const m={...market(),active:true,execution:{active:true},quoteObservedAt:9900,history:[{time:9800,price:.4}]} as TennisMarket;
  const report={...m,observedAt:9950,contextUpdatedAt:9500,score:'14-0',bid:.01,ask:.99,quoteObservedAt:9950,history:[]};
  const result=marketWithWatchedContext(m,report,10000);
  assert.equal(result.score,'14-0');assert.equal(result.observedAt,9950);assert.equal(result.contextUpdatedAt,9500);
  assert.equal(result.bid,m.bid);assert.equal(result.ask,m.ask);assert.equal(result.quoteObservedAt,9900);assert.deepEqual(result.history,m.history);
  assert.equal(marketWithWatchedContext(result,m,10000),result);
  assert.equal(marketWithWatchedContext(m,{...report,eventId:'other-game'},10000),m);
  const delayedCatalog={...m,observedAt:9990,contextUpdatedAt:9000,score:'7-0'};
  const preserved=marketWithWatchedContext(delayedCatalog,report,10000);
  assert.equal(preserved.score,'14-0');assert.equal(preserved.contextUpdatedAt,9500);assert.equal(preserved.observedAt,9950);
});
test('selected book refresh updates a game beyond the stream cap without changing score/status clocks or paper state',()=>{
  const m=market(),i=input(),s=session(),before=structuredClone({m,i,s});
  const result=marketWithWatchedBook(m,i,s,10000);
  assert.equal(result.quoteObservedAt,9800);assert.equal(result.quoteSourceTime,9500);assert.equal(result.quoteSource,'REST');assert.equal(result.bid,.49);assert.equal(result.ask,.5);
  assert.equal(result.score,'7-0');assert.equal(result.observedAt,1000);assert.equal(result.contextUpdatedAt,500);assert.equal(result.history[0].time,9800);
  assert.deepEqual({m,i,s},before);
});
test('selected refresh rejects stale/future receipts, replay data, cached REST, source regression and cross-game responses',()=>{
  const m=market(),s=session();
  const cases=[{...input(),receivedAt:4999},{...input(),receivedAt:10001},{...input(),source:'REPLAY' as const},{...input(),sourceTime:9300},{...input(),sourceTime:null},{...input(),market:{...market(),slug:'old-selected-game'}},{...input(),restReceipt:undefined},{...input(),restReceipt:{...input().restReceipt!,cacheStatus:'HIT'}},{...input(),restReceipt:{...input().restReceipt!,requestedAt:9700}},{...input(),restReceipt:{...input().restReceipt!,receivedAt:10001}}];
  for(const i of cases){assert.ok(watchedBookIssue(i,s,10000,m));assert.equal(marketWithWatchedBook(m,i,s,10000),m);}
});
test('newer stream quote wins against a slower REST request; latest game identity and provider watermark remain authoritative',()=>{
  const m={...market(),quoteSource:'WEBSOCKET' as const,quoteObservedAt:9950,quoteSourceTime:9900};
  assert.equal(marketWithWatchedBook(m,input(),session(),10000),m);
  assert.equal(marketWithWatchedBook({...market(),yesName:'Different A'},input(),session(),10000).quoteSource,'CATALOG');
  const ws={...input(),source:'WEBSOCKET' as const,restReceipt:undefined};
  assert.equal(watchedBookIssue(ws,session(),10000,market()),null);
});
test('incomplete, crossed, unsorted and known-rejected books never replace valid chart prices',()=>{
  const m=market(),s=session();
  for(const book of [{...input().book,bids:[]},{...input().book,asks:[{price:.45,quantity:10}]},{...input().book,bids:[{price:.49,quantity:10},{price:.50,quantity:10}]},{...input().book,asks:[{price:.5,quantity:0}]}])assert.equal(marketWithWatchedBook(m,{...input(),book},s,10000),m);
  s.decisions=[{slug:m.slug,code:'BOOK_ORDER',bookTime:9800}] as TennisSession['decisions'];assert.equal(marketWithWatchedBook(m,input(),s,10000),m);
});
