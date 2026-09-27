import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTennisEvent,normalizeTennisExecution} from '../lib/tennis/normalize.ts';
import {selectTennisStreamMarkets} from '../lib/trading/stream-types.ts';
import {selectionSchema} from '../services/trading/contracts.ts';
import {applyTennisAction,createTennisSession,defaultTennisConfig} from '../lib/tennis/engine.ts';
// Minimal public-schema fixture captured from the CFB league feed on 2026-09-26.
const NOW=Date.parse('2026-09-26T01:47:25.554Z');
const winner={slug:'aec-cfb-navy-uab-2026-09-25',sportsMarketType:'football_team_full_game_winner',active:true,closed:false,status:'MARKET_STATUS_OPEN',minimumTradeQty:.01,orderPriceMinTickSize:.005,feeCoefficient:.0695,
  bestBidQuote:{value:'.415'},bestAskQuote:{value:'.420'},marketSides:[
    {long:false,description:'Blazers',teamId:1157,team:{id:1157,name:'UAB',league:'cfb',ordering:'home'}},
    {long:true,description:'Midshipmen',teamId:1245,team:{id:1245,name:'Navy',league:'cfb',ordering:'away'}}]};
const event={id:'110178',slug:'cfb-navy-uab-2026-09-25',title:'Navy vs UAB',startTime:'2026-09-25T23:00:00Z',active:true,live:true,ended:false,score:'20-24',period:'Q4',eventState:{type:'football',live:true,ended:false,period:'Q4',elapsed:'10:37',updatedAt:'2026-09-26T01:46:53.954819Z'},markets:[winner]};
test('live college football uses explicit teams, fresh status and exchange-specific execution rules',()=>{
  const [market]=normalizeTennisEvent(event,'CFB',NOW);
  assert.equal(market.yesName,'Navy');assert.equal(market.noName,'UAB');assert.equal(market.active,true);assert.equal(market.live,true);
  assert.equal(market.period,'Q4');assert.equal(market.clock,'10:37');assert.equal(market.score,'20-24');
  assert.equal(market.contextUpdatedAt,Date.parse(event.eventState.updatedAt));assert.equal(market.observedAt,NOW);
  assert.equal(market.execution?.priceIncrement,.005);assert.equal(market.execution?.minimumTradeQty,.01);assert.equal(market.execution?.feeCoefficient,.0695);
});

test('football drive context maps possession separately from field territory and keeps zero timeouts',()=>{
  const footballState={driveState:{possessionTeamId:'1245',down:4,yfd:12,fieldPosition:{teamId:'1157',yard:12}},
    timeouts:[{teamId:'1245',remaining:0},{teamId:'1157',remaining:3}]};
  const [market]=normalizeTennisEvent({...event,eventState:{...event.eventState,footballState}},'CFB',NOW);
  assert.deepEqual(market.football,{possessionTeam:'Navy',possessionTeamId:'1245',down:4,yardsToGo:12,fieldPosition:{team:'UAB',teamId:'1157',yard:12},
    timeouts:[{team:'UAB',remaining:3},{team:'Navy',remaining:0}]});
  // The provider uses down=0 during transitions; it is not a playable zeroth down.
  const transition=normalizeTennisEvent({...event,eventState:{...event.eventState,footballState:{...footballState,driveState:{...footballState.driveState,down:0,yfd:0}}}},'CFB',NOW)[0];
  assert.equal(transition.football?.down,null);assert.equal(transition.football?.yardsToGo,null);
  assert.equal(transition.football?.phase,'between-plays');
});

test('missing or invalid drive data stays unknown instead of inventing a team or down',()=>{
  assert.equal(normalizeTennisEvent(event,'CFB',NOW)[0].football,null);
  const footballState={driveState:{possessionTeamId:'unknown',down:3.5,yfd:-1,fieldPosition:{teamId:'unknown',yard:99}},
    timeouts:[{teamId:'1245',remaining:4},{teamId:'1157',remaining:2},{teamId:'1157',remaining:1}]};
  const [market]=normalizeTennisEvent({...event,eventState:{...event.eventState,footballState}},'CFB',NOW);
  assert.deepEqual(market.football,{possessionTeam:null,possessionTeamId:null,down:null,yardsToGo:null,fieldPosition:null,timeouts:[]});
  assert.deepEqual(market.footballIdentity,{yesTeamId:'1245',noTeamId:'1157'});
});
test('football rejects mismatched teams, missing fees, totals and tennis-market types',()=>{
  assert.equal(normalizeTennisExecution({...winner,sportsMarketType:'football_total'},'CFB'),null);
  assert.equal(normalizeTennisExecution({...winner,sportsMarketType:'tennis_match_winner'},'CFB'),null);
  assert.equal(normalizeTennisExecution({...winner,feeCoefficient:undefined},'CFB'),null);
  assert.equal(normalizeTennisEvent(event,'NFL',NOW).length,0);
  const wrong=structuredClone(event);wrong.markets[0].marketSides[0].teamId=999;
  assert.equal(normalizeTennisEvent(wrong,'CFB',NOW).length,0);
});
test('football never infers live from a past start and refuses final or interrupted games',()=>{
  const past=normalizeTennisEvent({...event,live:false,eventState:{...event.eventState,live:false}},'CFB',NOW)[0];
  assert.equal(past.live,false);assert.equal(past.active,false);
  const final=normalizeTennisEvent({...event,period:'FT'},'CFB',NOW)[0];assert.equal(final.ended,true);assert.equal(final.active,false);
  const suspended=normalizeTennisEvent({...event,period:'SUSPENDED'},'CFB',NOW)[0];assert.equal(suspended.active,false);
  const conflict=normalizeTennisEvent({...event,eventState:{...event.eventState,live:false}},'CFB',NOW)[0];assert.equal(conflict.active,false);
});
test('NFL moneyline metadata is accepted without treating an upcoming game as live',()=>{
  const nfl=structuredClone(event);nfl.live=false;nfl.eventState.live=false;nfl.period='NS';nfl.startTime=new Date(NOW+86400000).toISOString();
  for(const side of nfl.markets[0].marketSides)side.team.league='nfl';
  const [market]=normalizeTennisEvent(nfl,'NFL',NOW);
  assert.equal(market.league,'NFL');assert.equal(market.live,false);assert.equal(market.active,true);assert.equal(market.execution?.league,'NFL');
});
test('football streams preserve protected tennis markets and validate CFB subscriptions',()=>{
  const [football]=normalizeTennisEvent(event,'CFB',NOW);
  const protectedTennis={...football,slug:'held-tennis',league:'WTA',active:false,live:false};
  const result=selectTennisStreamMarkets([football],[protectedTennis]);assert.equal(result.ok,true);
  if(result.ok){assert.equal(result.selections.length,2);assert.ok(result.selections.some(s=>s.league==='CFB'));assert.ok(result.selections.some(s=>s.slug==='held-tennis'));}
  assert.equal(selectionSchema.safeParse({slug:football.slug,league:'CFB',detail:'book'}).success,true);
});
test('switching sports preserves the existing cash and identity; reset retains the chosen sport',()=>{
  const session=createTennisSession({...defaultTennisConfig(10),strategy:'auto'},NOW);
  const next=applyTennisAction(session,{action:'update-rules',sessionId:session.id,commandId:'sport-switch',expectedRulesRevision:0,rules:{leagues:['NFL','CFB']}},[],NOW+1);
  assert.equal(next.id,session.id);assert.equal(next.cash,10);assert.equal(next.config.entryBudget,2);assert.equal(next.config.maxSpreadPoints,2);assert.deepEqual(next.ledger,session.ledger);
  assert.deepEqual(next.config.leagues,['NFL','CFB']);assert.equal(next.rulesRevision,1);
  const reset=applyTennisAction(next,{action:'reset',bankroll:10,commandId:'reset'},[],NOW+2);
  assert.deepEqual(reset.config.leagues,['NFL','CFB']);assert.equal(reset.config.strategy,'auto');
});
