import test from 'node:test';
import assert from 'node:assert/strict';
import {marketWithWatchedContext} from '../lib/tennis/chart-data.ts';
import {retainedTennisContext} from '../lib/tennis/market-context.ts';
import {tennisScoreMarket,TENNIS_SCORE_NOW as now} from './helpers/tennis-scoreboard-fixture.ts';

for(const merge of [marketWithWatchedContext,retainedTennisContext]){
  test(`${merge.name}: newer tennis score preserves prices and quote evidence`,()=>{
    const stored=tennisScoreMarket();
    const latest={...stored,observedAt:now,contextUpdatedAt:now-100,price:.9,bid:.89,ask:.91,quoteObservedAt:now,
      tennis:{...stored.tennis!,games:{yes:1,no:3},points:{yes:'15',no:'0'},serving:'YES' as const},score:'4-6, 1-3:15-0'};
    const result=merge(stored,latest,now);
    assert.deepEqual(result.tennis,latest.tennis);
    assert.deepEqual(result.tennisIdentity,stored.tennisIdentity);
    assert.equal(result.score,latest.score);
    for(const key of ['price','bid','ask','quoteObservedAt','quoteSource','quoteSourceTime','execution'] as const)assert.deepEqual(result[key],stored[key]);
    assert.equal(result.contextUpdatedAt,now-100);
    assert.equal(stored.score,'4-6, 0-3:40-40');
  });
  test(`${merge.name}: rejects switched players and older scores`,()=>{
    const stored=tennisScoreMarket();
    const latest={...stored,observedAt:now,contextUpdatedAt:now-100};
    assert.equal(merge(stored,{...latest,tennisIdentity:{yesPlayerId:'202',noPlayerId:'101'}},now),stored);
    assert.equal(merge(stored,{...latest,tennisIdentity:undefined},now),stored);
    assert.equal(merge(stored,{...latest,contextUpdatedAt:stored.contextUpdatedAt!-1},now),stored);
  });
}
