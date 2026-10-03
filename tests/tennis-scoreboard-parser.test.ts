import test from 'node:test';
import assert from 'node:assert/strict';
import {tennisPlayerIdentity,tennisScoreboardState} from '../lib/tennis/scoreboard.ts';
import {normalizeTennisEvent} from '../lib/tennis/normalize.ts';

// Reduced recorded Krueger/Ann Li score and participant fields; no production fallback data.
const yes={long:true,description:'Krueger',teamId:4657,team:{id:4657,name:'Krueger',league:'wta',ordering:'home'}};
const no={long:false,description:'Ann Li',teamId:3147,team:{id:3147,name:'Ann Li',league:'wta',ordering:'away'}};
type ScoreRow={competitorId:unknown;score:unknown};
type SetRow={number:unknown;type:unknown;label:unknown;scores:unknown};
const set=(number:number,a:number,b:number):SetRow=>({number,type:'PERIOD_SCORE_TYPE_REGULATION',label:`S${number}`,scores:[{competitorId:'4657',score:a},{competitorId:'3147',score:b}]});
function state(){return {type:'tennis',score:'4-6, 0-3:30-40',period:'S2',updatedAt:'2026-10-03T04:08:52Z',live:true,ended:false,
  tennisState:{tournamentName:'Beijing Women Singles',servingTeamId:3147 as unknown},periodScores:[set(1,4,6),set(2,0,3)]};}
const parse=(value:unknown)=>tennisScoreboardState(value,yes,no);
function event(value=state()){
  return {id:'parser-fixture',slug:'parser-fixture',title:'Krueger vs. Ann Li',active:true,live:true,ended:false,score:value.score,period:value.period,startTime:'2026-10-03T03:00:00Z',eventState:value,
    markets:[{slug:'parser-fixture-match',sportsMarketType:'tennis_match_winner',active:true,status:'MARKET_STATUS_OPEN',minimumTradeQty:.01,orderPriceMinTickSize:.005,feeCoefficient:.0695,marketSides:[no,yes]}]};
}

test('recorded Krueger and Ann Li fields map sets, games, points and serving by explicit player IDs',()=>{
  assert.deepEqual(tennisPlayerIdentity(yes,no),{yesPlayerId:'4657',noPlayerId:'3147'});
  assert.deepEqual(parse(state()),{sets:[{number:1,yes:4,no:6},{number:2,yes:0,no:3}],setsWon:{yes:0,no:1},games:{yes:0,no:3},points:{yes:'30',no:'40'},serving:'NO'});
  const [market]=normalizeTennisEvent(event(),'WTA',Date.parse('2026-10-03T04:08:53Z'));
  assert.equal(market.yesName,'Krueger');assert.equal(market.noName,'Ann Li');assert.deepEqual(market.tennis,parse(state()));
});

test('set and competitor row ordering cannot swap player scores',()=>{
  const value=state();value.periodScores.reverse();for(const row of value.periodScores)(row.scores as ScoreRow[]).reverse();
  assert.deepEqual(parse(value),parse(state()));
});

test('reversing outcome identities reverses mapped scores and serving without trusting home or away order',()=>{
  const board=tennisScoreboardState(state(),no,yes);
  assert.deepEqual(board?.sets,[{number:1,yes:6,no:4},{number:2,yes:3,no:0}]);
  assert.deepEqual(board?.points,{yes:'40',no:'30'});assert.equal(board?.serving,'YES');
});

test('reversed raw text order maps points only through matching ID-assigned set pairs',()=>{
  const value=state();value.score='6-4, 3-0:40-30';
  assert.deepEqual(parse(value)?.points,{yes:'30',no:'40'});assert.deepEqual(parse(value)?.games,{yes:0,no:3});
});

test('all tied set pairs leave point order unassigned while retaining mapped games and known server',()=>{
  const value=state();value.period='TB1';value.periodScores=[set(1,6,6)];value.score='6-6:6-4';
  assert.deepEqual(parse(value),{sets:[{number:1,yes:6,no:6}],setsWon:{yes:0,no:0},games:{yes:6,no:6},points:null,serving:'NO'});
});

test('disagreeing or incomplete raw set sequences never assign points',()=>{
  for(const score of ['4-6, 0-2:30-40','0-3:30-40','4-6, 0-3, 0-0:30-40','4-6, 3-0:30-40']){
    const value=state();value.score=score;assert.equal(parse(value)?.points,null,score);assert.deepEqual(parse(value)?.games,{yes:0,no:3});
  }
});

test('a known serving player with no set scores does not invent zero games or set wins',()=>{
  const value=state();value.periodScores=[];
  assert.deepEqual(parse(value),{sets:[],setsWon:null,games:null,points:null,serving:'NO'});
});

test('missing or unknown serving IDs never become an inferred server',()=>{
  for(const servingTeamId of [undefined,null,0,'unknown',9999]){
    const value=state();value.tennisState.servingTeamId=servingTeamId;assert.equal(parse(value)?.serving,null);
  }
});

test('invalid, duplicate or conflicting outcome IDs reject player assignment',()=>{
  for(const bad of [{...yes,teamId:0},{...yes,teamId:'unknown'},{...yes,teamId:4657,team:{...yes.team,id:9999}},{...yes,teamId:3147,team:{...yes.team,id:3147}}]){
    assert.equal(tennisPlayerIdentity(bad,no),null);assert.equal(tennisScoreboardState(state(),bad,no),null);
  }
});

test('missing tennis state or period score arrays do not fabricate a scoreboard',()=>{
  for(const value of [null,{}, {...state(),type:'football'},{...state(),periodScores:null},{...state(),periodScores:{}}])assert.equal(parse(value),null);
});

test('duplicate, nonsequential, mislabeled or invalid set records reject the scoreboard',()=>{
  const variants:SetRow[][]=[[set(1,4,6),set(1,0,3)],[set(2,0,3)],[set(1,4,6),set(3,0,3)]];
  for(const change of [{number:0},{number:6},{number:'1'},{label:'S2'},{type:'PERIOD_SCORE_TYPE_OVERTIME'}])variants.push([{...set(1,4,6),...change}]);
  for(const periodScores of variants)assert.equal(parse({...state(),periodScores}),null);
});

test('unknown or repeated competitors and malformed numeric score rows reject the scoreboard',()=>{
  const variants:unknown[]=[null,[],[{competitorId:'4657',score:4}], [{competitorId:'4657',score:4},{competitorId:'4657',score:6}],
    [{competitorId:'4657',score:4},{competitorId:'9999',score:6}]];
  for(const score of ['4',NaN,Infinity,-1,100,4.5])variants.push([{competitorId:'4657',score},{competitorId:'3147',score:6}]);
  for(const scores of variants)assert.equal(parse({...state(),periodScores:[{...set(1,4,6),scores}]}),null);
});

test('only legal completed set scores count as set wins',()=>{
  for(const [a,b,yesWins,noWins] of [[6,4,1,0],[4,6,0,1],[7,5,1,0],[7,6,1,0],[8,6,1,0],[6,5,0,0],[7,0,0,0],[8,7,0,0]]){
    const value={...state(),period:'S1',score:'',periodScores:[set(1,a,b)]};
    assert.deepEqual(parse(value)?.setsWon,{yes:yesWins,no:noWins},`${a}-${b}`);
  }
});

test('regular advantage point labels normalize A or AD while keeping explicit player order',()=>{
  for(const label of ['AD','A','ad','a']){
    const value=state();value.score=`4-6, 0-3:${label}-40`;assert.deepEqual(parse(value)?.points,{yes:'AD',no:'40'});
  }
  const value=state();value.score='4-6, 0-3:0-15';assert.deepEqual(parse(value)?.points,{yes:'0',no:'15'});
});

test('malformed or unsupported regular point values preserve sets without assigning points',()=>{
  for(const score of ['4-6, 0-3:7-4','4-6, 0-3:50-40','4-6, 0-3:LOVE-15','4-6, 0-3:30','4-6, 0-3:30-40 extra']){
    const value=state();value.score=score;assert.equal(parse(value)?.points,null,score);assert.equal(parse(value)?.sets.length,2);
  }
});

test('tie-break digit points need an unambiguous set order and the current final set',()=>{
  const value=state();value.period='TB2';value.periodScores=[set(1,6,4),set(2,6,6)];value.score='6-4, 6-6:10-8';
  assert.deepEqual(parse(value)?.points,{yes:'10',no:'8'});
  value.score='6-4, 6-6:AD-8';assert.equal(parse(value)?.points,null);
  value.score='6-4, 6-6:10-8';value.period='TB1';assert.equal(parse(value)?.points,null);
});

test('Tennis normalization uses the score state clock and fields when top-level event fields disagree',()=>{
  const value=state();value.live=false;value.ended=true;value.period='FT';value.score='4-6, 0-6';value.periodScores=[set(1,4,6),set(2,0,6)];
  const raw={...event(value),live:true,ended:false,score:'4-6, 0-3:30-40',period:'S2'};
  const [market]=normalizeTennisEvent(raw,'WTA',Date.parse('2026-10-03T04:08:53Z'));
  assert.equal(market.score,value.score);assert.equal(market.period,'FT');assert.equal(market.live,false);assert.equal(market.ended,true);assert.equal(market.active,false);
  assert.equal(market.contextUpdatedAt,Date.parse(value.updatedAt));assert.deepEqual(market.tennis?.setsWon,{yes:0,no:2});
});
