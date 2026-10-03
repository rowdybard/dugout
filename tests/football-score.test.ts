import test from 'node:test';
import assert from 'node:assert/strict';
import {espnFootballMapping,normalizeEspnFootballReport} from '../lib/tennis/espn-football.ts';
import {withEspnFootballFallback} from '../lib/tennis/football-fallback.ts';
import {retainFootballScore} from '../lib/tennis/football-score.ts';
import {assessFootballContext} from '../lib/tennis/football-context.ts';
import {FOOTBALL_FEED_NOW as NOW,montanaMarket,espnSummary} from './helpers/football-feed-fixture.ts';

const summary=()=>({...espnSummary(NOW-91_000),scoringPlays:[{id:'401868094160',type:{text:'Field Goal Good'},scoringType:{name:'field-goal'},team:{id:'70'},awayScore:10,homeScore:7,period:{number:1}}]});
test('a verified ESPN scoring summary names the team and field goal even while the drive is stale',()=>{
  const market=montanaMarket(),report=normalizeEspnFootballReport(summary(),espnFootballMapping(market)!,NOW);
  assert.equal(report.lastScore?.team,'Idaho');assert.equal(report.lastScore?.kind,'field-goal');assert.equal(report.lastScore?.reportTime,null,'No invented scoring time');
  const result=withEspnFootballFallback(market,{fetchedAt:NOW,retryAt:NOW+10000,report},NOW);
  assert.equal(result.footballLastScore?.score,'10-7');assert.equal(result.football,null);assert.notEqual(assessFootballContext(result,NOW).assessment.status,'fresh');
});
test('scoring details must match the reviewed teams, current score and non-future source time',()=>{
  const market=montanaMarket(),mapping=espnFootballMapping(market)!;
  for(const changed of [
    {...summary(),scoringPlays:[{...summary().scoringPlays[0],team:{id:'999'}}]},
    {...summary(),scoringPlays:[{...summary().scoringPlays[0],homeScore:10}]},
    {...summary(),scoringPlays:[{...summary().scoringPlays[0],wallclock:new Date(NOW+1).toISOString()}]},
    {...summary(),header:{...summary().header,id:'401868095'}},
  ])assert.equal(normalizeEspnFootballReport(changed,mapping,NOW).lastScore,undefined);
});
test('Polymarket score deltas name the team without guessing a scoring play',()=>{
  const before=montanaMarket(NOW-3000,NOW-4000),after={...montanaMarket(),score:'10-10'};
  const result=retainFootballScore(after,before);
  assert.equal(result.footballLastScore?.team,'Idaho');assert.equal(result.footballLastScore?.points,3);assert.equal(result.footballLastScore?.kind,'score-change');
  assert.equal(result.contextUpdatedAt,after.contextUpdatedAt);
  assert.equal(retainFootballScore({...after,score:'13-10'},before).footballLastScore,undefined,'Two changed scores cannot identify one scoring event');
  for(const contextUpdatedAt of [NaN,Infinity,-1,NOW+1])assert.equal(retainFootballScore({...after,contextUpdatedAt},before).footballLastScore,undefined,'An invalid or future report cannot establish a scoring update');
});
test('last score survives clock ticks and stale drive reports with its original time',()=>{
  const market=montanaMarket(),scored=retainFootballScore({...market,score:'10-10'}, {...market,score:'10-7',contextUpdatedAt:NOW-5000});
  const next=retainFootballScore({...market,score:'10-10',clock:'0:50',observedAt:NOW+60_000,contextUpdatedAt:NOW+59_000},scored);
  assert.deepEqual(next.footballLastScore,scored.footballLastScore);
  assert.equal(next.footballLastScore?.reportTime,NOW-1000);assert.equal(next.football,null);
});
