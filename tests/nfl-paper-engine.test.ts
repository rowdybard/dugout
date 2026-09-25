import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBotConfig, newBot, stepBot, contextBlock } from '../lib/bot/engine.ts';
import type { BotConfig, BotInput, BotSession } from '../lib/bot/types.ts';

// SYNTHETIC ENGINEERING FIXTURES ONLY. No real games, network calls, orders,
// market forecasts, investment recommendations, or historical profit claims.
// Run: node --experimental-strip-types --test /workspace/scratch/e4ccea95fba6/nfl-paper-engine.proposed.test.ts
// When incorporating into the repository, replace absolute imports with ../lib/...
const NOW = Date.parse('2026-09-25T01:00:00Z');
const SLUG = 'synthetic-nfl-winner';
const GAME = 'synthetic-polymarket-game';
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.000002, `${actual} != ${expected}`);
type Side = 'YES' | 'NO';

function input(time = NOW, side: Side = 'YES'): BotInput {
  const bid = side === 'YES' ? 0.39 : 0.59;
  const ask = side === 'YES' ? 0.41 : 0.61;
  const yesProbability = side === 'YES' ? 0.7 : 0.3;
  const start = new Date(NOW - 600_000).toISOString();
  return {
    market: {
      slug: SLUG, id: SLUG, gameId: GAME, game: 'Synthetic away @ Synthetic home',
      title: 'Synthetic away wins', oppositeTitle: 'Synthetic home wins', league: 'NFL', start,
      kind: 'football_team_full_game_winner', teams: [], question: 'Synthetic fixture', rules: '',
      bid, ask, price: ask, volume: null, fee: 0.0695, active: true, history: [], signals: [], observedAt: time,
    },
    executionMarket: { slug: SLUG, league: 'NFL', active: true, minimumTradeQty: 1, quantityIncrement: 1, priceIncrement: 0.01, feeCoefficient: 0.0695 },
    book: { bids: [{ price: bid, quantity: 100 }], asks: [{ price: ask, quantity: 100 }], state: 'MARKET_STATE_OPEN', time: new Date(time).toISOString() },
    receivedAt: time, source: 'REST',
    context: {
      slug: SLUG, league: 'NFL', status: 'available', receivedAt: time,
      source: { name: 'Synthetic source', url: 'https://example.invalid', support: 'public-undocumented' },
      game: {
        id: '123', start, state: 'live', statusText: 'Synthetic live game', period: 'Q1', clock: '10:00',
        away: { id: '1', name: 'Synthetic Away', abbreviation: 'SA', score: 0 },
        home: { id: '2', name: 'Synthetic Home', abbreviation: 'SH', score: 0 },
      },
      players: [
        { id: 'qa', name: 'Synthetic Quarterback A', team: 'Synthetic Away', role: 'last_observed_passer', observedAt: new Date(time - 1000).toISOString(), stats: [] },
        { id: 'qh', name: 'Synthetic Quarterback H', team: 'Synthetic Home', role: 'last_observed_passer', observedAt: new Date(time - 1000).toISOString(), stats: [] },
      ],
      changes: [], injuries: [], injuryStatus: 'source_reports', injuryReceivedAt: time, limitations: [],
      winEstimate: {
        provider: 'ESPN', gameId: '123', playId: '10', playTime: time - 1000, receivedAt: time,
        homeProbability: 1 - yesProbability, awayProbability: yesProbability, tieProbability: 0,
        sourceUrl: 'https://example.invalid/synthetic-probability',
      },
    },
    forecast: {
      status: 'available', modelId: 'ESPN_LIVE_REFERENCE', modelVersion: 'espn-live-reference-v1',
      gameId: '123', yesTeamId: '1', yesProbability, homeProbability: 1 - yesProbability,
      generatedAt: time, sportsReceivedAt: time, playId: '10', playTime: time - 1000, playerImpactModeled: false,
    },
  };
}

function session(): BotSession { return newBot(defaultBotConfig(10, ['NFL']), NOW - 20_000); }

/** Drive the actual warmup instead of manually inventing an eligible strategy state. */
function warmed(side: Side = 'YES'): BotSession {
  const first = stepBot(session(), [input(NOW - 10_000, side)], NOW - 10_000);
  const second = stepBot(first, [input(NOW - 5000, side)], NOW - 5000);
  assert.equal(first.positions.length, 0);
  assert.equal(second.positions.length, 0);
  return second;
}

function entered(side: Side = 'YES'): BotSession {
  const result = stepBot(warmed(side), [input(NOW, side)], NOW);
  assert.equal(result.positions.filter(position => position.status === 'open').length, 1, 'synthetic fixture must exercise an actual engine fill');
  return result;
}

test('NFL synthetic $10 bankroll supports complementary YES and NO entries after independent observations', () => {
  for (const side of ['YES', 'NO'] as const) {
    const before = warmed(side), unchanged = JSON.stringify(before);
    const after = stepBot(before, [input(NOW, side)], NOW);
    assert.equal(JSON.stringify(before), unchanged, 'evaluation must not mutate the persisted input session');
    const position = after.positions[0];
    assert.equal(after.config.startingCash, 10);
    assert.equal(position.side, side);
    assert.equal(position.contracts, 4);
    near(position.entry, 0.41);
    near(position.fee, 0.07);
    near(position.amount, 1.71);
    near(after.cash, 8.29);
    near(after.cash + position.amount, 10);
    assert.equal(after.executions.filter(fill => fill.apply && fill.cashDelta < 0).length, 1);
  }
});

test('NFL synthetic cached context cannot satisfy the independent snapshot warmup', () => {
  const s = session(), snapshot = input(NOW - 1000);
  assert.notEqual(contextBlock(s, snapshot, NOW), null);
  assert.notEqual(contextBlock(s, snapshot, NOW), null);
  assert.equal(s.contextBaselines[GAME].independentSnapshots, 1);
});

test('NFL synthetic six-point threshold includes fees, not just the visible asking price', () => {
  const i = input();
  if (i.forecast?.status !== 'available') throw new Error('Bad synthetic forecast fixture');
  i.forecast.yesProbability = 0.475; // 6.5 points over 41c, but only 4.75 over all-in cost.
  i.context.winEstimate!.awayProbability = 0.475;
  i.context.winEstimate!.homeProbability = 0.525;
  const next = stepBot(warmed(), [i], NOW);
  assert.equal(next.positions.length, 0);
  near(next.cash, 10);
  assert.ok(next.decisions.some(decision => /does not clear entry cost/.test(decision.reason)));
});

test('NFL synthetic entry needs enough current buyers to absorb its entire size', () => {
  const i = input();
  i.book.bids[0].quantity = 1;
  const next = stepBot(warmed(), [i], NOW);
  assert.equal(next.positions.length, 0);
  near(next.cash, 10);
  assert.ok(next.decisions.some(decision => /exit book cannot absorb/.test(decision.reason)));
});

test('NFL synthetic target exits work for YES and NO without a current reference or sports context', () => {
  for (const side of ['YES', 'NO'] as const) {
    const s = entered(side), original = s.positions[0];
    s.status = 'paused';
    const quote = input(NOW + 1000, side);
    quote.book = { ...quote.book, bids: [{ price: side === 'YES' ? 0.7 : 0.28, quantity: 100 }], asks: [{ price: side === 'YES' ? 0.72 : 0.3, quantity: 100 }] };
    quote.context.status = 'unavailable'; quote.context.game = null; quote.forecast = undefined;
    const next = stepBot(s, [quote], NOW + 1000);
    assert.equal(next.status, 'paused');
    assert.equal(next.positions.filter(position => position.status === 'open').length, 0);
    const closed = next.positions.find(position => position.id === original.id)!;
    assert.equal(closed.status, 'closed');
    near(closed.exit!, 0.7);
    near(closed.payout!, 2.74); // 4 * 70c less the estimated 6c exit fee.
    near(next.cash, 11.03);
    assert.equal(next.executions.filter(fill => fill.apply && fill.cashDelta < 0).length, 1);
  }
});

test('NFL synthetic partial manual exit never consumes the same observed depth twice', () => {
  const s = entered(), position = s.positions[0], thin = input(NOW + 1000);
  thin.book.bids[0].quantity = 1;
  const once = stepBot(s, [thin], NOW + 1000, position.id);
  assert.equal(once.positions.filter(p => p.status === 'closed').reduce((sum, p) => sum + p.contracts, 0), 1);
  const repeated = stepBot(once, [thin], NOW + 2000);
  assert.equal(repeated.positions.filter(p => p.status === 'closed').reduce((sum, p) => sum + p.contracts, 0), 1);
  near(repeated.cash, once.cash);
  near(repeated.positions.find(p => p.id === position.id)!.contracts, 3);
  near(repeated.positions.reduce((sum, p) => sum + p.amount, 0), position.amount);
  const fresh = stepBot(repeated, [input(NOW + 3000)], NOW + 3000);
  assert.equal(fresh.positions.filter(p => p.status === 'open').length, 0);
  assert.equal(fresh.positions.reduce((sum, p) => sum + p.contracts, 0), 4);
  assert.notEqual(fresh.status, 'running', 'manual exit retains control instead of reopening');
});

test('NFL synthetic stale and future books cannot fund entries despite an attractive reference', () => {
  for (const mutate of [
    (i: BotInput) => { i.receivedAt = NOW - 15_001; },
    (i: BotInput) => { i.receivedAt = NOW + 1; },
    (i: BotInput) => { i.source = 'REPLAY'; },
  ]) {
    const i = input(); mutate(i);
    const next = stepBot(warmed(), [i], NOW);
    assert.equal(next.positions.length, 0);
    near(next.cash, 10);
  }
});

test('NFL synthetic final entry gate rechecks the play time even when generatedAt is fresh', () => {
  for (const playTime of [NOW - 120_001, NOW + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const i = input();
    if (i.forecast?.status !== 'available' || !('playTime' in i.forecast)) throw new Error('Bad synthetic NFL fixture');
    i.forecast.playTime = playTime;
    // Source context stays valid so this specifically probes the final forecast gate.
    const next = stepBot(warmed(), [i], NOW);
    assert.equal(next.positions.length, 0, `playTime=${playTime} must not enter`);
    near(next.cash, 10);
  }
});

test('NFL synthetic missing or mismatched reference cannot be replaced by price movement', () => {
  for (const mutate of [
    (i: BotInput) => { i.forecast = undefined; },
    (i: BotInput) => { i.forecast = { status: 'unavailable', reason: 'Synthetic missing reference' }; },
    (i: BotInput) => { if (i.forecast?.status === 'available') i.forecast.gameId = 'different-game'; },
    (i: BotInput) => { if (i.forecast?.status === 'available') i.forecast.generatedAt = NOW + 1; },
  ]) {
    const i = input(); mutate(i);
    const next = stepBot(warmed(), [i], NOW);
    assert.equal(next.positions.length, 0);
    near(next.cash, 10);
  }
});

test('NFL synthetic malformed reference configuration fails before creating a session', () => {
  for (const gap of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 0, 1]) {
    const config = defaultBotConfig(10, ['NFL']);
    config.nflLiveReference!.minimumProbabilityGap = gap;
    assert.throws(() => newBot(config, NOW), `minimumProbabilityGap=${gap}`);
  }
  const wrongVersion = { ...defaultBotConfig(10, ['NFL']), nflLiveReference: { modelVersion: 'unverified-model', minimumProbabilityGap: 0.06 } } as unknown as BotConfig;
  assert.throws(() => newBot(wrongVersion, NOW));
});

test('NFL synthetic changed quarterback or injury report pauses new entries', () => {
  for (const kind of ['quarterback', 'injury'] as const) {
    const i = input();
    if (kind === 'quarterback') i.context.players[0] = { ...i.context.players[0], id: 'replacement-qb', name: 'Synthetic Replacement' };
    else i.context.injuries = [{ name: 'Synthetic Receiver', team: 'Synthetic Away', position: 'WR', status: 'Questionable', detail: 'Synthetic source change', reportedAt: new Date(NOW - 1000).toISOString(), sourceUrl: 'https://example.invalid' }];
    const next = stepBot(warmed(), [i], NOW);
    assert.equal(next.positions.length, 0, kind);
    near(next.cash, 10);
    assert.ok(next.contextBaselines[GAME].quarantined.length > 0, kind);
  }
});

test('NFL synthetic out-of-order context cannot turn a repeated snapshot into independent confirmation', () => {
  const s = session();
  contextBlock(s, input(NOW - 1000), NOW);
  const before = structuredClone(s.contextBaselines[GAME]);
  assert.notEqual(contextBlock(s, input(NOW - 2000), NOW), null);
  assert.equal(s.contextBaselines[GAME].receivedAt, before.receivedAt);
  assert.notEqual(contextBlock(s, input(NOW - 1000), NOW), null);
  assert.equal(s.contextBaselines[GAME].independentSnapshots, 1);
});

test('NFL synthetic future source changes and injury publications stay blocked across warmup', () => {
  for (const kind of ['change', 'injury'] as const) {
    const s = session(), i = input(NOW - 1000);
    if (kind === 'change') i.context.changes = [{ id: 'future-change', type: 'QB_change', team: 'Synthetic Away', previous: { id: 'old-qb', name: 'Old' }, replacement: { id: 'qa', name: 'Synthetic Quarterback A' }, sourceEventTime: new Date(NOW + 10_000).toISOString(), detectedAt: NOW, description: 'Synthetic future event', implications: [] }];
    else i.context.injuries = [{ name: 'Synthetic Receiver', team: 'Synthetic Away', position: 'WR', status: 'Questionable', detail: 'Synthetic report', reportedAt: new Date(NOW + 10_000).toISOString(), sourceUrl: 'https://example.invalid' }];
    assert.notEqual(contextBlock(s, i, NOW), null, kind);
    i.context.receivedAt = NOW;
    assert.notEqual(contextBlock(s, i, NOW), null, kind);
  }
});
