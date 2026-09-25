import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePaperEntry, type EntryAnalysisInput } from '../lib/bot/entry-analysis.ts';
import type { Market } from '../lib/market/types.ts';

// Synthetic policy/accounting cases only; never rendered as games or historical results.
const now = Date.parse('2026-09-23T16:00:00Z');
function input(): EntryAnalysisInput {
  return {
    now,
    market: { slug: 'test', league: 'MLB' } as Market,
    executionMarket: { slug: 'test', league: 'MLB', active: true, minimumTradeQty: 0.01, quantityIncrement: 0.01, priceIncrement: 0.01, feeCoefficient: 0 },
    book: { bids: [{ price: 0.49, quantity: 100 }], asks: [{ price: 0.5, quantity: 100 }], state: 'MARKET_STATE_OPEN', time: new Date(now).toISOString() },
    account: { cash: 10, availableQuantity: 0, marketExposure: 0, totalExposure: 0 },
    policy: { now, bookReceivedAt: now, bookSource: 'REST', stateCertain: true, maxBookAgeMs: 15_000, maxCommandAgeMs: 15_000, maxOrderBudget: 2, maxMarketExposure: 2, maxTotalExposure: 4, automation: 'PAPER' },
    side: 'YES', budget: 2, entryLimitPrice: 0.5, stopReturn: 0.06, strategyVersion: 'synthetic-test-v1',
    context: {
      slug: 'test', league: 'MLB', status: 'available', receivedAt: now - 1_000,
      source: { name: 'Synthetic test', url: 'https://example.invalid', support: 'official' },
      game: { id: 'source-game', start: new Date(now + 3_600_000).toISOString(), state: 'pregame', statusText: 'Pregame',
        away: { id: 'A', name: 'Team A', abbreviation: 'A', score: null }, home: { id: 'B', name: 'Team B', abbreviation: 'B', score: null } },
      players: [
        { id: 'P1', name: 'Pitcher One', team: 'Team A', role: 'probable_pitcher', stats: [] },
        { id: 'P2', name: 'Pitcher Two', team: 'Team B', role: 'probable_pitcher', stats: [] },
      ], changes: [], limitations: [], injuryStatus: 'source_reports', injuryReceivedAt: now - 1_000, injuries: [],
    }, priorContext: null,
  };
}
function warmed() {
  const value = input();
  value.priorContext = analyzePaperEntry(value).nextContext;
  value.context!.receivedAt = now;
  return value;
}
const blocked = (value: EntryAnalysisInput, code: string) => {
  const result = analyzePaperEntry(value);
  assert.equal(result.eligibleForExperiment, false);
  assert.ok(result.vetoes.some(item => item.code === code), JSON.stringify(result));
  return result;
};

test('a $2 price experiment can be eligible without claiming expected return or mutating the $10 account', () => {
  const value = warmed(), result = analyzePaperEntry(value);
  assert.equal(result.eligibleForExperiment, true);
  assert.equal(result.expectedReturn, null);
  assert.equal(result.entry!.cashDelta, -2);
  assert.equal(result.liquidation!.cashDelta, 1.96);
  assert.equal(value.account.cash, 10);
});
test('re-reading the same cached snapshot never finishes context warmup', () => {
  const value = input();
  value.priorContext = blocked(value, 'CONTEXT_WARMUP').nextContext;
  assert.equal(blocked(value, 'CONTEXT_WARMUP').nextContext!.independentSnapshots, 1);
});
test('initial historical substitutions establish a baseline; their first-fetch detectedAt is not event time', () => {
  const value = input();
  value.context!.changes = [{ id: 'old', type: 'pitcher_change', team: 'Team A', previous: {id:'P0',name:'Old'}, replacement: {id:'P1',name:'New'}, sourceEventTime: new Date(now - 3_600_000).toISOString(), detectedAt: now, description: 'Old event', implications: [] }];
  value.priorContext = analyzePaperEntry(value).nextContext;
  assert.equal(value.priorContext!.quarantined.length, 0);
  value.context!.receivedAt = now;
  assert.equal(analyzePaperEntry(value).eligibleForExperiment, true);
  value.context!.changes.push({ ...value.context!.changes[0], id: 'new', sourceEventTime: new Date(now - 500).toISOString() });
  blocked(value, 'PLAYER_CHANGE_UNMODELED');
});
test('a reported starter identity change is quarantined without assigning a probability effect', () => {
  const value = warmed();
  value.context!.players[0].id = 'REPLACEMENT';
  const result = blocked(value, 'KEY_PLAYER_CHANGED');
  assert.equal(result.expectedReturn, null);
});
test('new injury reports remain quarantined after the report disappears', () => {
  const value = warmed();
  value.context!.injuries = [{ name: 'Another Player', team: 'Team A', position: 'SS', status: 'Out', detail: 'source report', reportedAt: new Date(now - 3_600_000).toISOString(), sourceUrl: 'https://example.invalid' }];
  value.priorContext = blocked(value, 'INJURY_UNMODELED').nextContext;
  value.context!.injuries = [];
  blocked(value, 'INJURY_UNMODELED');
});
test('unknown, recorded and future sports evidence cannot pass entry eligibility', () => {
  const unknown = warmed(); unknown.context = null; blocked(unknown, 'CONTEXT_UNKNOWN');
  const replay = warmed(); replay.context!.replayAt = now; blocked(replay, 'CONTEXT_STALE');
  const future = warmed(); future.context!.receivedAt = now + 1; blocked(future, 'CONTEXT_STALE');
  const noInjuries = warmed(); noInjuries.context!.injuryStatus = 'not_verified'; blocked(noInjuries, 'INJURY_COVERAGE_UNKNOWN');
});
test('a new NFL passer is evidence of changed context, not a declared injury or permanent replacement', () => {
  const value = input(); value.market.league = 'NFL'; value.executionMarket.league = 'NFL'; value.context!.league = 'NFL';
  value.context!.players.forEach(player => { player.role = 'last_observed_passer'; });
  value.priorContext = analyzePaperEntry(value).nextContext; value.context!.receivedAt = now;
  value.context!.changes = [{ id: 'pass', type: 'QB_change', team: 'Team A', previous: {id:'P1',name:'One'}, replacement: {id:'P3',name:'Three'}, sourceEventTime: new Date(now - 500).toISOString(), detectedAt: now, description: 'Different passer', implications: [] }];
  const result = blocked(value, 'PLAYER_CHANGE_UNMODELED');
  assert.match(result.vetoes.find(item => item.code === 'PLAYER_CHANGE_UNMODELED')!.reason, /does not establish an injury/);
});
test('spread or fees already at the stop threshold reject entry, including exact equality', () => {
  const spread = warmed(); spread.book.bids[0].price = 0.47; blocked(spread, 'COST_ALREADY_AT_STOP');
  const fees = warmed(); fees.executionMarket.feeCoefficient = 0.0695;
  const result = blocked(fees, 'COST_ALREADY_AT_STOP');
  assert.ok(result.entry!.fees > 0 && result.liquidation!.fees > 0);
});
test('full entry size without full exit depth is not treated as liquid', () => {
  const value = warmed(); value.book.bids[0].quantity = 2;
  blocked(value, 'EXIT_DEPTH_INSUFFICIENT');
});
test('NO uses complementary executable book prices and the same fee-inclusive checks', () => {
  const value = warmed(); value.side = 'NO'; value.entryLimitPrice = 0.51;
  const result = analyzePaperEntry(value);
  assert.equal(result.eligibleForExperiment, true);
  assert.equal(result.entry!.averagePrice, 0.51);
  assert.equal(result.liquidation!.averagePrice, 0.5);
});
