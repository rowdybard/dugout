import test from 'node:test';
import assert from 'node:assert/strict';
import {baseballContext,normalizeTennisEvent,normalizeTennisExecution} from '../lib/tennis/normalize.ts';
import {decisionContext} from '../lib/tennis/engine-plan.ts';
import {featureRegistry,readFeature} from '../lib/decision/features.ts';
import {SPORT_FEATURES} from '../lib/decision/sports/index.ts';
import {applyTennisAction,createTennisSession,stepTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisInput,TennisMarket} from '../lib/tennis/types';

const START=Date.parse('2026-09-27T17:05:00Z'),SLUG='aec-mlb-nym-wsh-2026-09-27';
/** Shape copied from a real /v2/leagues/mlb/events response (Sep 27, 2026): no live flag pregame, period "NS". */
function rawEvent(over:Record<string,unknown>={}){
  return {id:'124665',slug:'mlb-nym-wsh-2026-09-27',title:'New York Mets vs. Washington Nationals',active:true,closed:false,archived:false,hidden:false,
    startTime:'2026-09-27T17:05:00Z',period:'NS',eventState:{type:'baseball',updatedAt:'2026-09-27T13:09:22Z',mainSpreadLine:-1.5,mainTotalLine:8},
    markets:[{slug:SLUG,sportsMarketType:'baseball_team_full_game_winner',marketType:'moneyline',status:'MARKET_STATUS_OPEN',active:true,closed:false,
      feeCoefficient:0.0695,orderPriceMinTickSize:0.005,minimumTradeQty:0.01,gameStartTime:'2026-09-27T17:05:00Z',
      bestBidQuote:{value:'0.555'},bestAskQuote:{value:'0.56'},
      marketSides:[{long:true,description:'New York Mets',teamId:3018,team:{id:3018,name:'New York Mets',league:'mlb',ordering:'away'}},
        {long:false,description:'Washington Nationals',teamId:3029,team:{id:3029,name:'Washington Nationals',league:'mlb',ordering:'home'}}]}],
    ...over};
}

test('MLB pregame events normalize to an active team market with verified exchange rules',()=>{
  const [market]=normalizeTennisEvent(rawEvent(),'MLB',START-3_600_000);
  assert.ok(market);assert.equal(market.league,'MLB');assert.equal(market.active,true);assert.equal(market.live,false);
  assert.equal(market.yesName,'New York Mets');assert.equal(market.noName,'Washington Nationals');assert.equal(market.unavailableReason,undefined);
  assert.equal(market.football,undefined,'no football context for baseball');
  assert.deepEqual(normalizeTennisExecution(rawEvent().markets[0],'MLB'),{slug:SLUG,league:'MLB',active:true,minimumTradeQty:.01,quantityIncrement:.01,priceIncrement:.005,feeCoefficient:.0695});
  assert.equal(validateTennisConfig({...defaultLiveTennisConfig(),leagues:['MLB']}),null);
});

test('MLB states that are not verified stay untradable',()=>{
  const started=normalizeTennisEvent(rawEvent({period:'T3'}),'MLB',START+3_600_000)[0];
  assert.equal(started.active,false,'an in-progress game without a verified live flag is not tradable');
  assert.equal(normalizeTennisEvent(rawEvent(),'MLB',START+60_000)[0].active,false,'past the scheduled start without a live flag');
  assert.equal(normalizeTennisEvent(rawEvent({eventState:{type:'football'}}),'MLB',START-3_600_000).length,0,'wrong sport type');
  const mismatched=rawEvent();(mismatched.markets[0].marketSides[1].team as {league:string}).league='nfl';
  assert.equal(normalizeTennisEvent(mismatched,'MLB',START-3_600_000).length,0,'team league must match');
  assert.equal(normalizeTennisEvent(rawEvent(),'NFL',START-3_600_000).length,0,'an MLB winner market is not an NFL one');
});

function input(time:number,bid:number,ask:number,market:TennisMarket):TennisInput{
  return {receivedAt:time,source:'REST',sourceTime:time,book:{bids:[{price:bid,quantity:500}],asks:[{price:ask,quantity:500}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    market:{...market,observedAt:time,contextUpdatedAt:time}};
}

test('the bot acts on MLB evidence: pregame resting quotes (lead), no pregame taker bets (dropped)',()=>{
  const market=normalizeTennisEvent(rawEvent(),'MLB',START-3_600_000)[0];
  let session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['MLB'],focusSlug:SLUG},START-7_200_000);
  session=applyTennisAction(session,{action:'start',commandId:'mlb-start'},[],START-7_200_000);
  // An hour out: the MLB pregame maker lead permits paper quotes on both sides.
  const t=START-3_600_000;
  session=stepTennisSession(session,[input(t,.555,.56,market)],t);
  assert.ok(session.maker?.quotes.YES&&session.maker.quotes.NO,session.maker?.reason);
  assert.equal(session.maker!.quotes.YES!.price,.555);assert.equal(session.maker!.quotes.NO!.price,.44);
  assert.equal(session.maker!.quotes.YES!.quantity,9,'whole 0.01 increments of $5 at 55.5¢');
  // Six minutes out, favourite-hold proposes, but MLB pregame bets are a measured loser: no entry.
  const close=START-6*60_000;
  session=stepTennisSession(session,[input(close,.555,.56,market)],close);
  assert.equal(session.pending,null);
  assert.ok(session.enginePlan!.considered.some(trade=>trade.strategy==='favourite-hold'&&trade.result==='DROPPED'),JSON.stringify(session.enginePlan));
});

test('large real book sizes are valid six-decimal quantities (regression: 271789.34 was rejected as malformed)',async()=>{
  const {normalizeTennisBook}=await import('../lib/tennis/normalize.ts');
  const {toUnits}=await import('../lib/trading/money.ts');
  const book=normalizeTennisBook({marketData:{marketSlug:SLUG,state:'MARKET_STATE_OPEN',transactTime:'2026-09-27T14:00:00Z',
    bids:[{px:{value:'0.4750'},qty:'271789.3400'},{px:{value:'0.4800'},qty:'8869.7100'}],offers:[{px:{value:'0.4850'},qty:'256604.3400'}]}},SLUG);
  assert.deepEqual(book.bids[0],{price:.48,quantity:8869.71});assert.equal(book.bids[1].quantity,271789.34);
  assert.equal(toUnits(271789.34),BigInt(271789340000));assert.equal(toUnits(1101149.58),BigInt(1101149580000));
  for(const value of [0.1234567,271789.3400001,12.3456789])assert.throws(()=>toUnits(value),/six-place/);
  assert.throws(()=>normalizeTennisBook({marketData:{marketSlug:SLUG,state:'MARKET_STATE_OPEN',transactTime:'',bids:[{px:{value:'0.4750'},qty:'1.1234567'}],offers:[]}},SLUG),/malformed/);
});

// ---- Live MLB state (verified Sep 27, 2026 against the official MLB Stats API) --------------------------------

/** Live shape copied from /v2/leagues/mlb/events during NYM @ WSH (Mets 4, Nationals 5), with a count and runners. */
function liveEvent(period:string,baseballState:Record<string,unknown>,over:Record<string,unknown>={}){
  return rawEvent({live:true,period,score:'4-5',eventState:{type:'baseball',live:true,ended:false,score:'4-5',period,updatedAt:'2026-09-27T19:45:38Z',
    baseballState,periodScores:[]},...over});
}
const LIVE_AT=Date.parse('2026-09-27T19:45:40Z');
const RUNNERS={balls:3,strikes:2,outs:1,onFirst:true,onSecond:true,onThird:false,inningHalf:'T'};

test('MLB live state: inning, half, count, outs and runners are read only when the period and the state agree',()=>{
  const [market]=normalizeTennisEvent(liveEvent('Top 6th',RUNNERS),'MLB',LIVE_AT);
  assert.equal(market.live,true);assert.equal(market.yesOrdering,'away');
  assert.deepEqual(market.baseball,{inning:6,half:'top',outs:1,balls:3,strikes:2,onFirst:true,onSecond:true,onThird:false});
  assert.equal(baseballContext('Bot 10th',{...RUNNERS,inningHalf:'B'})?.inning,10,'extra innings');
  assert.equal(baseballContext('Mid 6th',{...RUNNERS,outs:0,balls:0,strikes:0,inningHalf:'M'})?.half,'middle');
  assert.equal(baseballContext('End 2nd',{...RUNNERS,inningHalf:'E'})?.half,'end');
  assert.equal(baseballContext('Top 6th',{...RUNNERS,inningHalf:'B'}),null,'period and state disagree');
  assert.equal(baseballContext('Top 6th',{...RUNNERS,balls:4}),null,'impossible count');
  assert.equal(baseballContext('Top 6th',{...RUNNERS,onThird:undefined}),null,'missing base');
  assert.equal(baseballContext('T6',RUNNERS),null,'unverified period format');
  assert.equal(normalizeTennisEvent(rawEvent(),'MLB',START-3_600_000)[0].baseball,undefined,'no live state pregame');
});

test('MLB live state reaches the engine only while fresh, from each side\'s point of view',()=>{
  const market={...normalizeTennisEvent(liveEvent('Top 6th',RUNNERS),'MLB',LIVE_AT)[0]};
  const session=createTennisSession({...defaultLiveTennisConfig(100),leagues:['MLB'],focusSlug:SLUG},LIVE_AT);
  const fresh=input(LIVE_AT,.4,.41,market);
  const ctx=decisionContext(session,fresh,LIVE_AT,'live');
  assert.equal(ctx.game!.period,6);assert.equal(ctx.game!.yesScore,4);assert.equal(ctx.game!.noScore,5);
  const f=(name:string,side:'yes'|'no'='yes')=>readFeature(featureRegistry(SPORT_FEATURES),name,ctx,side);
  assert.equal(f('inning'),6);assert.equal(f('baseball.half'),'top');assert.equal(f('outs'),1);assert.equal(f('balls'),3);assert.equal(f('strikes'),2);
  assert.equal(f('baseball.batting','yes'),true,'the Mets (away, YES) bat in the top half');assert.equal(f('baseball.batting','no'),false);
  assert.equal(f('runnersOn'),2);assert.equal(f('runnerInScoringPosition'),true);assert.equal(f('baseOutState'),'12-|1');
  // A report older than 45 s gives no game facts at all.
  const stale={...fresh,market:{...fresh.market,contextUpdatedAt:LIVE_AT-60_000}};
  const old=decisionContext(session,stale,LIVE_AT,'live');
  assert.equal(old.game!.yesScore,undefined);assert.equal(readFeature(featureRegistry(SPORT_FEATURES),'outs',old,'yes'),undefined);
  // Between halves nobody bats, and the base-out state is not reported.
  const mid={...market,baseball:baseballContext('Mid 6th',{...RUNNERS,outs:0,balls:0,strikes:0,onFirst:false,onSecond:false,inningHalf:'M'})};
  const between=decisionContext(session,input(LIVE_AT,.4,.41,mid),LIVE_AT,'live');
  assert.equal(readFeature(featureRegistry(SPORT_FEATURES),'baseball.batting',between,'yes'),undefined);
  assert.equal(readFeature(featureRegistry(SPORT_FEATURES),'baseOutState',between,'yes'),undefined);
  // Football features never read baseball facts.
  assert.equal(readFeature(featureRegistry(SPORT_FEATURES),'hasBall',ctx,'yes'),undefined);
});
