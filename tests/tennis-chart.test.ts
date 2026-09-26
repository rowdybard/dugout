import test from 'node:test';
import assert from 'node:assert/strict';
import {chartFills,marketWithSessionQuotes,mergeTennisHistory,outcomeHistory,quoteGaps,quoteMidpoint,withQuoteGaps} from '../lib/tennis/chart-data.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import type {TennisMarket,TennisLedgerEntry} from '../lib/tennis/types.ts';
test('stream midpoint comes from current quotes, and unavailable or crossed pairs stay empty',()=>{
  assert.equal(quoteMidpoint(.39,.41),.4);assert.equal(quoteMidpoint(null,.41),null);assert.equal(quoteMidpoint(.5,.4),null);assert.equal(quoteMidpoint(NaN,.4),null);
});

test('chart history merges sorted observations without losing recorded fields or mutating inputs',()=>{
  const saved=[{time:20,price:.4,bid:.39,ask:.41,score:'1-1'}];
  const result=mergeTennisHistory(saved,[{time:10,price:.3},{time:20,price:.4,bid:undefined,score:null},{time:30,price:NaN}]);
  assert.deepEqual(result,[{time:10,price:.3},{time:20,price:.4,bid:.39,ask:.41,score:null}]);
  assert.equal(saved[0].score,'1-1');
  assert.equal(mergeTennisHistory(Array.from({length:1205},(_,time)=>({time,price:.5})))[0].time,5);
});
test('opposite player swaps buy and sell sides; invalid or missing pairs stay unavailable',()=>{
  const [no]=outcomeHistory([{time:1,price:.4,bid:.39,ask:.41}],'NO');
  assert.ok(Math.abs(no.bid!-.59)<1e-10);assert.ok(Math.abs(no.ask!-.61)<1e-10);assert.equal(no.price,.6);
  for(const point of [{time:1,price:.4},{time:1,price:.4,bid:.6,ask:.3},{time:1,price:.4,bid:NaN,ask:.5},{time:1,price:.4,spread:-.4}]){
    const [result]=outcomeHistory([point],'YES');assert.equal(result.bid,undefined);assert.equal(result.ask,undefined);
  }
});
test('chart leaves a visible break for missing observations without inventing quotes',()=>{
  assert.equal(withQuoteGaps([]).length,0);
  assert.deepEqual(quoteGaps([{time:0,price:.5},{time:30001,price:.6}]),[{from:{time:0,price:.5},to:{time:30001,price:.6}}]);
  assert.equal(withQuoteGaps([{time:0,price:.5},{time:30000,price:.6}]).length,2);
  assert.deepEqual(withQuoteGaps([{time:0,price:.5},{time:30001,price:.6}]),[{time:0,price:.5},{time:1,price:null,bid:null,ask:null},{time:30001,price:.6}]);
});
test('fresh REST book updates held-match display without freshening old score or live status',()=>{
  const market={slug:'match',observedAt:100,contextUpdatedAt:80,quoteObservedAt:100,quoteSource:'CATALOG',price:.4,bid:.39,ask:.41,history:[],score:'1-1'} as unknown as TennisMarket;
  const session=createTennisSession();session.quotes={match:{time:1000,bid:.49,ask:.51,source:'REST'}};
  const result=marketWithSessionQuotes(market,session);
  assert.equal(result.price,.5);assert.equal(result.quoteObservedAt,1000);assert.equal(result.observedAt,100);assert.equal(result.contextUpdatedAt,80);
  assert.equal(result.history[0].time,1000);assert.equal(result.history[0].score,undefined);
  const freshStream={...market,quoteObservedAt:2000,bid:.59,ask:.61,price:.6,quoteSource:'WEBSOCKET' as const};
  assert.equal(marketWithSessionQuotes(freshStream,session).price,.6);
});
test('chart markers include only genuine bot fills for the selected player and window',()=>{
  const session=createTennisSession();
  const fill={id:'a',slug:'match',side:'YES',action:'BUY',source:'AUTOMATIC',time:10,actualPrice:.42,execution:{apply:true,filledQty:2,averagePrice:.43}} as TennisLedgerEntry;
  session.ledger=[fill,{...fill,id:'manual',source:'MANUAL'},{...fill,id:'no',side:'NO'},{...fill,id:'rejected',execution:{...fill.execution!,apply:false}},{...fill,id:'late',time:100}];
  assert.deepEqual(chartFills(session,'match','YES',0,20).map(f=>[f.id,f.price]),[['a',.42]]);
});
