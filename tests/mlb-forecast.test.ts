import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forecastMlbPregame, mlbHomeProbability, type MlbEloModel } from '../lib/bot/mlb-forecast.ts';
import {forecastInput} from '../lib/bot/forecast-input.ts';
import type {Market} from '../lib/market/types';
import type { SportsContext } from '../lib/sports-context/types';
const model=JSON.parse(readFileSync(new URL('../data/models/mlb-elo-2026-09-23.json',import.meta.url),'utf8')) as MlbEloModel;
const now=Date.parse('2026-09-23T23:00:00Z');
// Synthetic context tests only; no fabricated games are served by the proposal.
function context():SportsContext {return {
  slug:'test',league:'MLB',status:'available',receivedAt:now,source:{name:'MLB Stats API',url:'https://statsapi.mlb.com/api/v1.1/game/123/feed/live',support:'official'},
  game:{id:'123',start:'2026-09-24T01:00:00Z',state:'pregame',statusText:'Pregame',away:{id:'119',name:'Los Angeles Dodgers',abbreviation:'LAD',score:null},home:{id:'147',name:'New York Yankees',abbreviation:'NYY',score:null}},
  players:[],changes:[],limitations:[],injuryStatus:'not_verified',
};}
const request={now,yesTeamId:'147',marketFamily:'FULL_GAME_WINNER' as const};
test('known official MLB identities produce complementary pregame probabilities without claiming player impact',()=>{
 const home=forecastMlbPregame(model,context(),request), away=forecastMlbPregame(model,context(),{...request,yesTeamId:'119'});
 assert.equal(home.status,'available');assert.equal(away.status,'available');
 if(home.status!=='available'||away.status!=='available')return;
 assert.ok(Math.abs(home.yesProbability+away.yesProbability-1)<1e-12);
 assert.equal(home.playerImpactModeled,false);assert.equal(home.marketValueEstablished,false);
});
test('unknown IDs, mismapped YES teams and nonofficial identity namespaces do not get fallback predictions',()=>{
 assert.equal(forecastMlbPregame(model,context(),{...request,yesTeamId:'999'}).status,'unavailable');
 const wrong=context();wrong.game!.home.id='999';assert.equal(forecastMlbPregame(model,wrong,{...request,yesTeamId:'999'}).status,'unavailable');
 const namespace=context();namespace.source.url='https://example.com/';assert.equal(forecastMlbPregame(model,namespace,request).status,'unavailable');
});
test('current-day training, stale ratings, replay contexts and live games are rejected',()=>{
 assert.equal(forecastMlbPregame({...model,ratingsThroughDay:'2026-09-23'},context(),request).status,'unavailable');
 assert.equal(forecastMlbPregame({...model,ratingsThroughDay:'2026-09-01'},context(),request).status,'unavailable');
 const replay=context();replay.replayAt=now;assert.equal(forecastMlbPregame(model,replay,request).status,'unavailable');
 const live=context();live.game!.state='live';assert.equal(forecastMlbPregame(model,live,request).status,'unavailable');
});
test('TypeScript math matches an actually recorded Python holdout prediction',()=>{
 const rows=JSON.parse(readFileSync(new URL('../research/mlb-elo/holdout-predictions.json',import.meta.url),'utf8')).holdout2025;
 const row=rows[0];assert.ok(Math.abs(mlbHomeProbability(row.homeRatingBeforeDay,row.awayRatingBeforeDay,model.parameters.homeAdvantage)-row.p)<1e-12);
});
test('US long-side metadata maps by explicit team identity, never provider ID or list order',()=>{
 const m={slug:'test',league:'MLB',kind:'baseball_team_full_game_winner'} as Market;
 const metadata={marketSides:[{long:false,team:{id:119,name:'New York Yankees',abbreviation:'NYY'}},{long:true,team:{id:147,name:'Los Angeles Dodgers',abbreviation:'LAD'}}]};
 const f=forecastInput(model,m,context(),metadata,now);assert.equal(f.status,'available');
 if(f.status==='available')assert.equal(f.yesTeamId,'119');
 const conflict={marketSides:[{long:true,team:{name:'A team outside this game',abbreviation:'LAD'}}]};
 assert.equal(forecastInput(model,m,context(),conflict,now).status,'unavailable');
 assert.equal(forecastInput(model,m,context(),{marketSides:[]},now).status,'unavailable');
});
