import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultBotConfig,newBot,stepBot,contextBlock,entryCosts,botUniverse} from '../lib/bot/engine.ts';
import type {BotSession,BotInput} from '../lib/bot/types.ts';

// Synthetic engineering fixtures ONLY. No actual games, profits, or win claims.
const NOW=Date.parse('2026-09-23T18:00:00Z');
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<.000002,`${a} != ${b}`);
function input(slug='synthetic-a',bid=.39,ask=.41,time=NOW):BotInput {
  return {market:{slug,id:slug,gameId:slug,game:'Synthetic away @ Synthetic home',title:'Synthetic away wins',oppositeTitle:'Synthetic home wins',league:'MLB',start:new Date(NOW+3600000).toISOString(),kind:'baseball_team_full_game_winner',teams:[],question:'Synthetic',rules:'',bid,ask,price:ask,volume:null,fee:.0695,active:true,history:[],signals:[],observedAt:time},
    executionMarket:{slug,league:'MLB',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.0695},
    book:{bids:[{price:bid,quantity:100}],asks:[{price:ask,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date(time).toISOString()},
    receivedAt:time,source:'REST',forecast:{status:'available',modelId:'synthetic-engine-fixture',modelVersion:'mlb-elo-v1-2026-09-23',gameId:`game-${slug}`,homeTeamId:'h',awayTeamId:'a',yesTeamId:'a',homeProbability:.5,yesProbability:.5,homeRating:1500,awayRating:1500,ratingsThroughDay:'2026-09-22',sportsReceivedAt:time,generatedAt:time,purpose:'EXPERIMENTAL_PAPER_FORECAST',playerImpactModeled:false,marketValueEstablished:false,missingFeatures:['Synthetic test evidence only']},context:{slug,league:'MLB',status:'available',receivedAt:time,source:{name:'Synthetic context',url:'https://example.invalid',support:'official'},
      game:{id:`game-${slug}`,start:new Date(NOW+3600000).toISOString(),state:'pregame',statusText:'Synthetic pregame',away:{id:'a',name:'Synthetic away',abbreviation:'SA',score:null},home:{id:'h',name:'Synthetic home',abbreviation:'SH',score:null}},
      players:[{id:'pitcher-a',name:'Synthetic A',team:'Synthetic away',role:'probable_pitcher',stats:[]},{id:'pitcher-h',name:'Synthetic H',team:'Synthetic home',role:'probable_pitcher',stats:[]}],changes:[],injuries:[],injuryStatus:'source_reports',injuryReceivedAt:time,limitations:[]}};
}
function session():BotSession{return newBot(defaultBotConfig(10,['MLB']),NOW-2000);}
function arm(s:BotSession,i:BotInput,side:'YES'|'NO'='YES',baseline=.60){
  const previous=structuredClone(i);previous.receivedAt=NOW-1000;previous.context.receivedAt=NOW-1000;previous.context.injuryReceivedAt=NOW-1000;
  contextBlock(s,previous,NOW-1000);
  s.states[`${i.market.slug}:${side}`]={version:s.config.strategy.version,phase:'DIP',baseline,trough:.37,dipAt:NOW-60000,recoveryCount:1,lastObservedAt:NOW-1,lastObservedPrice:.39};
  const p=side==='YES'?.40:.60;
  s.histories[i.market.slug]=[{time:NOW-130000,price:side==='YES'?baseline:1-baseline},{time:NOW-1,price:p}];
  return s;
}
function entered(side:'YES'|'NO'='YES'){
  const i=side==='YES'?input():input('synthetic-a',.59,.61);
  const s=stepBot(arm(session(),i,side),[i],NOW);
  assert.equal(s.positions.filter(p=>p.status==='open').length,1,'fixture produces one genuine engine fill');
  return s;
}

test('valid outcome forecast permits either side using complementary probabilities',()=>{
  const yes=entered('YES'),no=entered('NO');
  assert.equal(yes.positions[0].side,'YES');assert.equal(no.positions[0].side,'NO');
  near(yes.positions[0].entry,.41);near(no.positions[0].entry,.41);near(yes.cash,no.cash);
  const trace=no.decisions.find(d=>d.action==='BUY')!;
  near(trace.forecastProbability!,.5);assert.ok(trace.allInEntryPrice!>.41);assert.equal(trace.modelVersion,'mlb-elo-v1-2026-09-23');
});

test('outcome filter rejects absent, stale, future or mismatched forecasts before funding entries',()=>{
  for(const mutate of [(i:BotInput)=>{i.forecast=undefined;},(i:BotInput)=>{i.forecast={status:'unavailable',reason:'Synthetic missing model'};},(i:BotInput)=>{if(i.forecast?.status==='available')i.forecast.generatedAt=NOW-90001;},(i:BotInput)=>{if(i.forecast?.status==='available')i.forecast.generatedAt=NOW+1;},(i:BotInput)=>{if(i.forecast?.status==='available')i.forecast.gameId='a-different-game';},(i:BotInput)=>{if(i.forecast?.status==='available')i.forecast.sportsReceivedAt=NOW-1;},(i:BotInput)=>{if(i.forecast?.status==='available')i.forecast.modelVersion='a-different-model';}]){
    const i=input(),s=arm(session(),i);mutate(i);const next=stepBot(s,[i],NOW);
    assert.equal(next.positions.length,0);assert.equal(next.cash,10);
  }
});

test('non-finite forecast clocks cannot disable age validation',()=>{
  for(const clock of [Number.NaN,Number.POSITIVE_INFINITY,Number.NEGATIVE_INFINITY]){
    const i=input(),s=arm(session(),i);if(i.forecast?.status==='available')i.forecast.generatedAt=clock;
    const next=stepBot(s,[i],NOW);assert.equal(next.positions.length,0);assert.equal(next.cash,10);
  }
});

test('forecast comparison uses entry fees and the selected side, not raw YES probability',()=>{
  const yes=input();if(yes.forecast?.status==='available')yes.forecast.yesProbability=.44;
  const feeBlocked=stepBot(arm(session(),yes),[yes],NOW);
  assert.equal(feeBlocked.positions.length,0,'44% clears a raw 41c ask by 3 points but not the all-in cost');
  assert.ok(feeBlocked.decisions.some(d=>/entry cost/.test(d.reason)));
  const no=input('synthetic-a',.59,.61);if(no.forecast?.status==='available')no.forecast.yesProbability=.8;
  const wrongSide=stepBot(arm(session(),no,'NO'),[no],NOW);
  assert.equal(wrongSide.positions.length,0,'YES probability of 80% is only 20% for the NO side');
  const cheapNo=input('synthetic-a',.59,.61);if(cheapNo.forecast?.status==='available')cheapNo.forecast.yesProbability=.2;
  const correctSide=stepBot(arm(session(),cheapNo,'NO'),[cheapNo],NOW);
  assert.equal(correctSide.positions[0]?.side,'NO');near(correctSide.decisions.find(d=>d.action==='BUY')!.forecastProbability!,.8);
});

test('model eligibility never overrides changed-player veto or forces a trade',()=>{
  const i=input(),s=arm(session(),i);if(i.forecast?.status==='available')i.forecast.yesProbability=.95;
  i.context.players[0].id='synthetic-unmodeled-replacement';
  const next=stepBot(s,[i],NOW);assert.equal(next.positions.length,0);assert.equal(next.cash,10);
  assert.ok(next.decisions.some(d=>/identity changed/.test(d.reason)));
});

test('an unavailable forecast cannot prevent requested liquidation of an existing position',()=>{
  const s=entered(),id=s.positions[0].id,i=input('synthetic-a',.39,.41,NOW+1000);
  i.forecast={status:'unavailable',reason:'Synthetic expired model'};i.context.status='unavailable';i.context.game=null;
  const next=stepBot(s,[i],NOW+1000,id);
  assert.equal(next.positions.filter(p=>p.status==='open').length,0);assert.notEqual(next.status,'running');
  assert.ok(next.cash>s.cash);
});
