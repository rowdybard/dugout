import test from 'node:test';
import assert from 'node:assert/strict';
import {decide,estimateCosts,matchingEvidence,quotePolicy,roleOf} from '../lib/decision/engine.ts';
import {EVIDENCE} from '../lib/decision/evidence.ts';
import {controlSide,FORWARD_TEST,holdReturn,observe,settle,summarize,type ForwardRow} from '../lib/decision/forward.ts';
import {parseBook,parseMarket,sportOfSlug} from '../lib/decision/polymarket.ts';

test('costs match the taker fee formula and research settle_return',()=>{
  const c=estimateCosts(.5,.49);
  assert.ok(Math.abs(c.entryFee-.0695*.25)<1e-12);assert.ok(Math.abs(c.breakEvenWinRate-(.5+.017375))<1e-12);
  assert.ok(Math.abs(c.impliedProbability!-.495)<1e-12);assert.ok(Math.abs(c.spread!-.01)<1e-12);
  // A round trip must beat both fees: exit bid x satisfies x - fee(x) = cost.
  const x=.5+c.breakEvenBidRise;assert.ok(Math.abs(x-.0695*x*(1-x)-c.costPerContract)<1e-9);
  assert.ok(Math.abs(holdReturn(.8,1,.0695)-(1-(.8+.0695*.16))/(.8+.0695*.16))<1e-12);
});

test('every scalping regime is refused, in paper and real money',()=>{
  for(const sport of ['NFL','MLB','CFB','ATP','WTA'] as const)for(const mode of ['paper','pilot','real'] as const){
    const verdict=decide({sport,phase:'live',style:'taker-scalp',mode,ask:.45,bid:.44});
    assert.equal(verdict.permitted,false);assert.equal(verdict.action,'block');
    assert.equal(verdict.code,sport==='NFL'||sport==='MLB'?'DROPPED':'NO_EVIDENCE');
  }
});

test('CFB pregame favourite is paper-only, underdog and longshot are dropped',()=>{
  const fav=decide({sport:'CFB',phase:'pregame',style:'taker-hold',mode:'paper',ask:.78,bid:.77});
  assert.equal(fav.action,'paper-only');assert.equal(fav.permitted,true);assert.equal(fav.deciding?.id,'cfb-pregame-favourite');assert.equal(fav.role,'favourite');
  for(const mode of ['real','pilot'] as const){
    const real=decide({sport:'CFB',phase:'pregame',style:'taker-hold',mode,ask:.78,bid:.77});
    assert.equal(real.permitted,false);assert.equal(real.code,'UNPROVEN_REAL');
  }
  const dog=decide({sport:'CFB',phase:'pregame',style:'taker-hold',mode:'paper',ask:.23,bid:.22});
  assert.equal(dog.code,'DROPPED');assert.equal(dog.deciding?.id,'cfb-pregame-underdog');
  // The price band outranks the role when both match.
  const longshot=decide({sport:'CFB',phase:'pregame',style:'taker-hold',mode:'paper',ask:.10,bid:.09});
  assert.equal(longshot.deciding?.id,'cfb-pregame-longshot');
});

test('price-specific losers override general results, and bands are (min, max]',()=>{
  assert.equal(decide({sport:'MLB',phase:'pregame',style:'taker-hold',mode:'paper',ask:.62,bid:.61}).deciding?.id,'mlb-pregame-mid-favourite');
  assert.equal(decide({sport:'MLB',phase:'pregame',style:'taker-hold',mode:'paper',ask:.72,bid:.71}).deciding?.id,'mlb-pregame-hold');
  assert.equal(decide({sport:'MLB',phase:'live',style:'taker-hold',mode:'paper',ask:.10,bid:.095}).deciding?.id,'mlb-live-longshot');
  assert.equal(decide({sport:'MLB',phase:'live',style:'taker-hold',mode:'paper',ask:.105,bid:.10}).deciding?.id,'mlb-live-longshot-10-20');
});

test('wide books and invalid prices are refused before any evidence applies',()=>{
  assert.equal(decide({sport:'CFB',phase:'pregame',style:'taker-hold',mode:'paper',ask:.79,bid:.69}).code,'NOT_EXECUTABLE');
  for(const [ask,bid] of [[0,null],[1,null],[.5,.6],[Number.NaN,null]] as const)
    assert.equal(decide({sport:'CFB',phase:'pregame',style:'taker-hold',mode:'paper',ask,bid}).code,'INVALID');
  assert.equal(roleOf(.5,.49),'underdog');assert.equal(roleOf(.51,.49),'favourite');
});

test('model probability is reported, never decisive',()=>{
  const verdict=decide({sport:'NFL',phase:'live',style:'taker-hold',mode:'paper',ask:.40,bid:.39,modelProbability:.60});
  assert.equal(verdict.permitted,false);assert.ok(verdict.modelEdge!>0.15);
});

test('no evidence row is proven yet, so nothing may use real money',()=>{
  assert.equal(EVIDENCE.filter(item=>item.status==='proven').length,0);
  for(const item of EVIDENCE)for(const sport of item.sports)for(const phase of item.phases)for(const style of item.styles)for(const ask of [.05,.3,.5,.6,.8,.95])
    assert.equal(decide({sport,phase,style,mode:'real',ask}).permitted,false,`${item.id} ${ask}`);
});

test('maker quote policy: stay out of NFL/MLB live, pilot the CFB and pregame leads, pull after events',()=>{
  assert.equal(quotePolicy('NFL','live','pilot').quote,false);assert.equal(quotePolicy('MLB','live','paper').quote,false);
  const cfb=quotePolicy('CFB','live','pilot');assert.equal(cfb.quote,true);assert.equal(cfb.status,'lead');assert.equal(cfb.pullAfterEventMs,30_000);
  assert.equal(quotePolicy('CFB','live','real').quote,false);
  assert.equal(quotePolicy('MLB','pregame','paper').quote,true);assert.equal(quotePolicy('MLB','pregame','paper').pullAfterEventMs,null);
  assert.equal(quotePolicy('ATP','live','paper').status,'none');
  assert.equal(matchingEvidence('CFB','pregame','maker')[0].id,'cfb-pregame-maker');
});

const MARKET={market:{slug:'aec-cfb-home-away-2026-10-03',question:'Home vs Away',gameStartTime:'2026-10-03T19:00:00Z',feeCoefficient:.0695,closed:false,status:'MARKET_STATUS_ACTIVE',
  marketSides:[{long:true,description:'Home',price:'0.8'},{long:false,description:'Away',price:'0.2'}]}};
const BOOK={marketData:{state:'MARKET_STATE_OPEN',bids:[{px:{value:'0.7700'},qty:'10'},{px:{value:'0.7800'},qty:'0'}],offers:[{px:{value:'0.7800'},qty:'5'},{px:{value:'0.7900'},qty:'5'}]}};

test('Polymarket US parsing: YES book, complementary NO prices, settlement only when resolved',()=>{
  assert.equal(sportOfSlug('aec-cfb-a-b-2026-10-03'),'CFB');assert.equal(sportOfSlug('atc-cfb-a-b-2026-10-03'),null);assert.equal(sportOfSlug('aec-nba-a-b'),null);
  const book=parseBook(BOOK)!;
  assert.deepEqual(book,{yes:{ask:.78,bid:.77},no:{ask:.23,bid:.22},open:true});
  const market=parseMarket(MARKET)!;
  assert.equal(market.sport,'CFB');assert.equal(market.yesSettle,null);assert.equal(market.startTime,Date.parse('2026-10-03T19:00:00Z'));
  const resolved=parseMarket({market:{...MARKET.market,closed:true,status:'MARKET_STATUS_RESOLVED',marketSides:[{long:true,description:'Home',price:'1'},{long:false,description:'Away',price:'0'}]}})!;
  assert.equal(resolved.yesSettle,1);
  assert.equal(parseMarket({market:{slug:'x'}}),null);assert.equal(parseBook({}),null);
});

test('forward test observes only inside the pregame window, picks what the engine permits, and settles once',()=>{
  const game=parseMarket(MARKET)!,book=parseBook(BOOK)!,start=game.startTime!;
  assert.equal(observe(undefined,game,book,start-4*60_000),null,'inside the last 5 minutes');
  assert.equal(observe(undefined,game,book,start-FORWARD_TEST.maxLeadMs-1),null,'too early');
  assert.equal(observe(undefined,{...game,sport:'NFL'},book,start-30*60_000),null);
  assert.equal(observe(undefined,{...game,startTime:Date.parse('2026-09-26T19:00:00Z')},book,Date.parse('2026-09-26T18:30:00Z')),null,'discovery-period game');
  const early=observe(undefined,game,book,start-60*60_000)!;
  const row=observe(early,game,book,start-20*60_000)!;
  assert.equal(row.minutesBeforeStart,20);assert.deepEqual(row.pick,{side:'yes',ask:.78,evidence:'cfb-pregame-favourite'});
  assert.equal(row.no.code,'DROPPED');assert.equal(observe(row,game,book,start-30*60_000),null,'never replaced by an older quote');
  const unresolved=settle(row,game,start+4*3600_000);assert.equal(unresolved,row);
  const done=settle(row,{...game,resolved:true,yesSettle:1},start+4*3600_000);
  assert.equal(done.yesSettle,1);assert.equal(settle(done,{...game,resolved:true,yesSettle:0},start+5*3600_000),done);
});

test('forward summary: controls, ties skipped, and the 300-trade kill rule',()=>{
  const row=(i:number,yesSettle:number|null):ForwardRow=>({slug:`aec-cfb-g${i}-2026-10-03`,title:'',startTime:'2026-10-03T19:00:00.000Z',observedAt:'2026-10-03T18:40:00.000Z',minutesBeforeStart:20,
    feeCoefficient:.0695,yes:{name:'H',ask:.78,bid:.77,code:'LEAD_PAPER'},no:{name:'A',ask:.23,bid:.22,code:'DROPPED'},pick:{side:'yes',ask:.78,evidence:'cfb-pregame-favourite'},yesSettle,settledAt:null});
  const few=summarize([row(1,1),row(2,0),row(3,.5),row(4,null)]);
  assert.equal(few.strategy.n,2);assert.equal(few.skipped,1);assert.equal(few.pending,1);assert.equal(few.status,'collecting');
  assert.equal(few.controls.underdog.n,2);assert.equal(few.controls.neverTrade.mean,0);
  assert.ok(Math.abs(few.strategy.mean!-(holdReturn(.78,1,.0695)+holdReturn(.78,0,.0695))/2)<1e-12);
  // 90% favourites at 78¢ is a real edge; 78% is exactly the price, which loses the fee.
  const winning=summarize(Array.from({length:300},(_,i)=>row(i,i%10===0?0:1)));
  assert.equal(winning.status,'passed');assert.ok(winning.strategy.lo!>0);
  const fair=summarize(Array.from({length:300},(_,i)=>row(i,i%50<39?1:0)));
  assert.equal(fair.status,'dropped');
  assert.ok(['yes','no'].includes(controlSide('aec-cfb-a')));assert.equal(controlSide('aec-cfb-a'),controlSide('aec-cfb-a'));
});
