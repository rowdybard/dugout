import test from 'node:test';
import assert from 'node:assert/strict';
import {freshTennisBook,normalizeTennisBook,normalizeTennisEvent,normalizeTennisExecution,normalizeTennisSettlement,tennisNumber} from '../lib/tennis/normalize.ts';

// Synthetic schema-contract fixtures, never shown in production as actual games or prices.
const now=Date.parse('2026-09-25T22:00:00Z');
const rawMarket={slug:'synthetic-tennis-match',sportsMarketType:'tennis_match_winner',active:true,closed:false,
  status:'MARKET_STATUS_OPEN',minimumTradeQty:0.01,orderPriceMinTickSize:0.01,feeCoefficient:0.0695,
  bestBidQuote:{value:'0.40',currency:'USD'},bestAskQuote:{value:'0.42',currency:'USD'},
  marketSides:[{long:false,description:'Player Two',team:{league:'atp'}},{long:true,description:'Player One',team:{league:'atp'}}]};
const event={id:'synthetic-event',slug:'synthetic-event',title:'Player One vs Player Two',active:true,closed:false,
  startTime:'2026-09-25T21:00:00Z',live:true,ended:false,score:'6-2, 2-0:40-30',period:'S2',
  eventState:{updatedAt:'2026-09-25T21:59:55Z',tennisState:{tournamentName:'Synthetic Men Singles',round:'quarterfinal'}},markets:[rawMarket]};
const rawBook={marketData:{marketSlug:rawMarket.slug,state:'MARKET_STATE_OPEN',transactTime:'2026-09-25T21:58:00Z',
  bids:[{px:{value:'0.39',currency:'USD'},qty:'5.25'},{px:{value:'0.40',currency:'USD'},qty:'3.5'}],
  offers:[{px:{value:'0.44',currency:'USD'},qty:'4'},{px:{value:'0.42',currency:'USD'},qty:'2.25'}],
  stats:{settlementPx:{value:'0.0000',currency:'USD'}}}};

test('tennis names follow explicit long flags even when sides arrive reversed',()=>{
  const [market]=normalizeTennisEvent(event,'ATP',now);
  assert.equal(market.yesName,'Player One');assert.equal(market.noName,'Player Two');assert.equal(market.league,'ATP');
  assert.equal(market.live,true);assert.equal(market.price,0.41000000000000003);assert.equal(market.active,true);
  assert.equal(market.observedAt,now);assert.equal(market.contextUpdatedAt,now-5000);assert.deepEqual(market.history,[]);
  assert.equal(market.execution?.feeCoefficient,0.0695);assert.equal(market.execution?.quantityIncrement,0.01);
});

test('WTA normalizes independently without an MLB or ATP fallback',()=>{
  const wta={...event,markets:[{...rawMarket,marketSides:rawMarket.marketSides.map(side=>({...side,team:{league:'wta'}}))}]};
  assert.equal(normalizeTennisEvent(wta,'WTA',now)[0]?.execution?.league,'WTA');
  assert.equal(normalizeTennisEvent(wta,'ATP',now).length,0);
});

test('only full-match singles winner markets qualify',()=>{
  for(const sportsMarketType of ['tennis_set_winner','tennis_match_games_spread','baseball_full_game_winner'])
    assert.deepEqual(normalizeTennisEvent({...event,markets:[{...rawMarket,sportsMarketType}]},'ATP',now),[]);
  assert.deepEqual(normalizeTennisEvent({...event,eventState:{tennisState:{tournamentName:'ATP Men Doubles'}}},'ATP',now),[]);
  assert.deepEqual(normalizeTennisEvent({...event,markets:[{...rawMarket,marketSides:[{long:true,description:'One / Two'},{long:false,description:'Three / Four'}]}]},'ATP',now),[]);
  assert.deepEqual(normalizeTennisEvent({...event,markets:[{...rawMarket,marketSides:[{long:true,description:'One'},{long:true,description:'Two'}]}]},'ATP',now),[]);
});

test('missing or invalid fees, minimum quantity and ticks never receive defaults',()=>{
  for(const change of [{feeCoefficient:undefined},{feeCoefficient:null},{feeCoefficient:''},{feeCoefficient:-0.1},{feeCoefficient:2},
    {minimumTradeQty:undefined},{minimumTradeQty:0},{orderPriceMinTickSize:undefined},{orderPriceMinTickSize:0},{orderPriceMinTickSize:1},{orderPriceMinTickSize:0.0000001}]){
    const [market]=normalizeTennisEvent({...event,markets:[{...rawMarket,...change}]},'ATP',now);
    assert.equal(market.execution,null);assert.equal(market.active,false);assert.match(market.unavailableReason??'',/rules/);
  }
  assert.equal(normalizeTennisExecution({...rawMarket,feeCoefficient:0},'ATP')?.feeCoefficient,0);
  assert.equal(tennisNumber(false),null);assert.equal(tennisNumber(null),null);assert.equal(tennisNumber(' '),null);
});

test('suspended and unconfirmed past-start matches block entry without inventing live play',()=>{
  const [suspended]=normalizeTennisEvent({...event,live:false,period:'Sus.'},'ATP',now);
  assert.equal(suspended.active,false);assert.equal(suspended.live,false);assert.match(suspended.unavailableReason??'',/suspended/);
  // Exchange status remains separate so the position engine may attempt a real quoted exit.
  assert.equal(suspended.execution?.active,true);
  const [unknown]=normalizeTennisEvent({...event,live:false,period:''},'ATP',now);
  assert.equal(unknown.active,false);assert.match(unknown.unavailableReason??'',/unconfirmed/);
  const [future]=normalizeTennisEvent({...event,live:false,period:'NS',startTime:'2026-09-26T01:00:00Z'},'ATP',now);
  assert.equal(future.active,true);assert.equal(future.live,false);
});

test('provider end or closed state cannot remain an active entry candidate',()=>{
  for(const change of [{ended:true},{closed:true},{eventState:{...event.eventState,ended:true}}]){
    const [market]=normalizeTennisEvent({...event,...change},'ATP',now);assert.equal(market.active,false);assert.equal(market.ended,true);
  }
  assert.deepEqual(normalizeTennisEvent({...event,hidden:true},'ATP',now),[]);
});

test('REST book validates the requested slug, sorts depth and preserves provider time',()=>{
  const book=normalizeTennisBook(rawBook,rawMarket.slug);
  assert.deepEqual(book.bids.map(l=>l.price),[0.4,0.39]);assert.deepEqual(book.asks.map(l=>l.price),[0.42,0.44]);
  assert.equal(book.asks[0].quantity,2.25);assert.equal(book.time,'2026-09-25T21:58:00Z');
  assert.throws(()=>normalizeTennisBook(rawBook,'other-match'),/unverified/);
  assert.throws(()=>normalizeTennisBook({marketData:{...rawBook.marketData,offers:null}},rawMarket.slug),/unverified/);
});

test('bad or crossed levels reject the whole snapshot rather than remove inconvenient prices',()=>{
  for(const bad of [{px:{value:'NaN'},qty:'3'},{px:{value:'0.4'},qty:'-1'},{px:{value:'1'},qty:'3'},{px:{value:'0.4'},qty:null}])
    assert.throws(()=>normalizeTennisBook({marketData:{...rawBook.marketData,bids:[...rawBook.marketData.bids,bad]}},rawMarket.slug),/malformed/);
  assert.throws(()=>normalizeTennisBook({marketData:{...rawBook.marketData,bids:[{px:{value:'0.5'},qty:'2'}]}},rawMarket.slug),/crossed/);
});

test('settlement requires the official endpoint shape and supports fair-price cancellation',()=>{
  assert.equal(normalizeTennisSettlement(rawBook,rawMarket.slug),null);
  assert.equal(normalizeTennisSettlement({slug:rawMarket.slug,settlement:0},rawMarket.slug),0);
  assert.equal(normalizeTennisSettlement({slug:rawMarket.slug,settlement:1},rawMarket.slug),1);
  assert.equal(normalizeTennisSettlement({slug:rawMarket.slug,settlement:0.37},rawMarket.slug),0.37);
  assert.equal(normalizeTennisSettlement({slug:'other',settlement:1},rawMarket.slug),null);
  assert.equal(normalizeTennisSettlement({slug:rawMarket.slug,settlement:null},rawMarket.slug),null);
  assert.equal(normalizeTennisSettlement({slug:rawMarket.slug,settlement:3},rawMarket.slug),null);
});

test('a connected stream cannot suppress REST after the five-second execution budget expires',()=>{
  assert.equal(freshTennisBook(now-5000,now),true);
  assert.equal(freshTennisBook(now-5001,now),false);
  assert.equal(freshTennisBook(now-12000,now),false);
  assert.equal(freshTennisBook(now+1,now),false);
  assert.equal(freshTennisBook(NaN,now),false);
});
