import test from 'node:test';
import assert from 'node:assert/strict';
import {chartFills,marketWithSessionQuotes,marketWithStreamQuote,mergeTennisHistory,outcomeHistory,quoteFreshForDisplay,quoteGaps,quoteMidpoint,withQuoteGaps} from '../lib/tennis/chart-data.ts';
import type {StreamQuote} from '../lib/trading/stream-types.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import type {TennisMarket,TennisLedgerEntry} from '../lib/tennis/types.ts';
test('display tolerates a small clock difference but never labels old or far-future quotes fresh',()=>{
  assert.equal(quoteFreshForDisplay(100050,100000,5000),true);
  assert.equal(quoteFreshForDisplay(94000,100000,5000),false);
  assert.equal(quoteFreshForDisplay(110000,100000,5000),false);
  assert.equal(quoteFreshForDisplay(NaN,100000,5000),false);
});
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
test('known rejected REST spikes disappear from every chart merge while audit evidence stays intact',()=>{
  const market={slug:'match',observedAt:100,quoteObservedAt:3000,quoteSource:'WEBSOCKET',price:.6225,bid:.62,ask:.625,
    history:[{time:1000,price:.6225},{time:2000,price:.6525},{time:3000,price:.6225}]} as unknown as TennisMarket;
  const session=createTennisSession();
  session.decisions=[{id:'rejected',time:2100,slug:'match',side:'YES',action:'SKIP',code:'BOOK_ORDER',reason:'Older provider time',bookTime:2000}];
  session.histories['match:YES']=[{time:2000,price:.6525}];
  const before=structuredClone({market,session});
  const result=marketWithSessionQuotes(market,session);
  assert.deepEqual(result.history.map(p=>p.price),[.6225,.6225]);assert.equal(result.price,.6225);
  assert.deepEqual({market,session},before);
  // The full owner-fenced exclusion list survives a reload after recent decisions roll off.
  const reloaded=marketWithSessionQuotes({...market,rejectedQuoteTimes:[2000]},null);
  assert.deepEqual(reloaded.history,result.history);
  const rejectedLatest=marketWithSessionQuotes({...market,quoteObservedAt:2000,price:.6525,rejectedQuoteTimes:[2000]},null);
  assert.equal(rejectedLatest.price,null);assert.equal(rejectedLatest.quoteObservedAt,0);
});

test('rejected retained history cannot crowd valid saved chart points out of the history limit',()=>{
  const market={slug:'match',observedAt:0,history:Array.from({length:1800},(_,i)=>({time:i+1,price:.5})),rejectedQuoteTimes:Array.from({length:1200},(_,i)=>i+601)} as unknown as TennisMarket;
  assert.equal(marketWithSessionQuotes(market,null).history.length,600);
});

test('visible stream cannot roll provider time backward or disguise a missing timestamp, even while paused',()=>{
  const session=createTennisSession();session.status='paused';session.bookSourceTimes={match:9500};
  const market={slug:'match',observedAt:100,quoteObservedAt:10000,quoteSourceTime:9500,price:.6225,bid:.62,ask:.625,history:[{time:10000,price:.6225}]} as unknown as TennisMarket;
  const quote={slug:'match',valid:true,source:'polymarket_us_websocket',receivedAt:12000,sourceTime:11900,bid:.63,ask:.635} as StreamQuote;
  for(const sourceTime of [9000,null,NaN,15001])assert.equal(marketWithStreamQuote(market,{...quote,sourceTime},session,12000),market);
  const ordered=marketWithStreamQuote(market,quote,session,12000);
  assert.equal(ordered.quoteSourceTime,11900);assert.equal(ordered.quoteObservedAt,12000);assert.equal(ordered.price,.6325000000000001);
  assert.equal(ordered.history.length,2);assert.equal(ordered.observedAt,100);
  // A local display watermark also protects against reconnect rollback before a server tick.
  assert.equal(marketWithStreamQuote(ordered,{...quote,receivedAt:14000,sourceTime:10000},session,14000),ordered);
  assert.equal(marketWithStreamQuote(market,{...quote,receivedAt:2000},session,12000),market);
  assert.equal(session.status,'paused');assert.equal(session.ledger.length,0);
});

test('chart markers include only genuine bot fills for the selected player and window',()=>{
  const session=createTennisSession();
  const fill={id:'a',slug:'match',side:'YES',action:'BUY',source:'AUTOMATIC',time:10,actualPrice:.42,execution:{apply:true,filledQty:2,averagePrice:.43}} as TennisLedgerEntry;
  session.ledger=[fill,{...fill,id:'manual',source:'MANUAL'},{...fill,id:'no',side:'NO'},{...fill,id:'rejected',execution:{...fill.execution!,apply:false}},{...fill,id:'late',time:100}];
  assert.deepEqual(chartFills(session,'match','YES',0,20).map(f=>[f.id,f.price]),[['a',.42]]);
});
