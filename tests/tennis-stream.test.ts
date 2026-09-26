import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTennisStreamMarkets } from '../lib/trading/stream-types.ts';
import { selectionsSchema } from '../services/trading/contracts.ts';
import { StreamState } from '../services/trading/state.ts';
import { usableStreamBook } from '../lib/trading/stream-book.ts';

// Synthetic subscription and protocol cases; these are not live matches or trading results.
const NOW = Date.parse('2026-09-25T21:00:00Z');
const candidate = (slug: string, league = 'ATP', live = false, startTime = new Date(NOW).toISOString()) => ({
  slug, league, live, startTime, active: true, ended: false,
});

test('paper subscription catalog rejects unknown, malformed, unsupported-sport and ended requests', () => {
  const markets = [candidate('known-atp'), candidate('known-mlb', 'MLB'), { ...candidate('ended-wta', 'WTA'), ended: true }];
  for (const slug of ['unknown', 'known-mlb', 'ended-wta']) {
    assert.deepEqual(selectTennisStreamMarkets(markets, [], slug), {
      ok: false, status: 404, error: 'This game market is not in the verified catalog or your paper session.',
    });
  }
  for (const slug of ['', '../private', 'x'.repeat(251)]) {
    const result = selectTennisStreamMarkets(markets, [], slug);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  }
});

test('tennis subscriptions prioritize current matches and limit discovery to twelve', () => {
  const markets = Array.from({ length: 15 }, (_, i) => candidate(`future-${i}`, i % 2 ? 'WTA' : 'ATP', false, new Date(NOW + i * 60000).toISOString()));
  markets.push(candidate('live-wta', 'WTA', true, new Date(NOW + 3600000).toISOString()), candidate('ignore-baseball', 'MLB', true));
  const result = selectTennisStreamMarkets(markets, []);
  assert.ok(result.ok);
  assert.equal(result.selections.length, 12);
  assert.equal(result.selections[0].slug, 'live-wta');
  assert.equal(result.selections[1].slug, 'future-0');
  assert.ok(result.selections.every(selection => selection.detail === 'book' && ['ATP', 'WTA'].includes(selection.league)));
  assert.equal(new Set(result.selections.map(selection => selection.slug)).size, 12);
});

test('persisted held and pending markets remain subscribed when discovery loses them', () => {
  const held = { ...candidate('held-wta', 'WTA'), active: false, ended: true };
  const pending = candidate('pending-atp');
  const result = selectTennisStreamMarkets([], [held, pending]);
  assert.ok(result.ok);
  assert.deepEqual(result.selections.map(selection => selection.slug), ['held-wta', 'pending-atp']);
  const selected = selectTennisStreamMarkets([candidate('selected-atp')], [held], 'selected-atp');
  assert.ok(selected.ok);
  assert.deepEqual(selected.selections.map(selection => selection.slug), ['held-wta', 'selected-atp']);
  assert.equal(selectTennisStreamMarkets([], [held], held.slug).ok, true);
});

test('protected exits are never dropped to fill discovery slots or duplicated', () => {
  const held = candidate('held-wta', 'WTA');
  const markets = [held, ...Array.from({ length: 20 }, (_, i) => candidate(`live-${i}`, 'ATP', true))];
  const result = selectTennisStreamMarkets(markets, [held]);
  assert.ok(result.ok);
  assert.equal(result.selections.length, 12);
  assert.equal(result.selections[0].slug, held.slug);
  assert.equal(result.selections.filter(selection => selection.slug === held.slug).length, 1);
});

test('ATP and WTA pass the same strict read-only subscription schema', () => {
  for (const league of ['ATP', 'WTA'] as const) {
    assert.ok(selectionsSchema.safeParse([{ slug: `synthetic-${league}`, league, detail: 'book' }]).success);
  }
  assert.equal(selectionsSchema.safeParse([{ slug: 'synthetic', league: 'TENNIS', detail: 'book' }]).success, false);
  assert.equal(selectionsSchema.safeParse([{ slug: 'synthetic', league: 'ATP', detail: 'book', orders: true }]).success, false);
});

test('tennis US books preserve read-only events and generation/freshness protections', () => {
  for (const league of ['ATP', 'WTA'] as const) {
    const state = new StreamState(true, () => NOW);
    const slug = `synthetic-${league}`;
    state.setSelections([{ slug, league, detail: 'book' }]);
    state.connected('market');
    const events: string[] = [];
    state.onEvent(event => events.push(event.type));
    const accepted = state.ingestMarket({
      requestId: 'synthetic-connection', subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA',
      marketData: {
        marketSlug: slug, bids: [{ px: { value: '0.40', currency: 'USD' }, qty: '20' }],
        offers: [{ px: { value: '0.42', currency: 'USD' }, qty: '30' }],
        state: 'MARKET_STATE_OPEN', transactTime: new Date(NOW).toISOString(),
      },
    });
    assert.equal(accepted, true);
    const quote = state.quotes.get(slug)!;
    assert.equal(quote.league, league);
    assert.deepEqual(events, ['quote']);
    assert.equal(state.snapshot().health.mode, 'read_only');
    assert.equal(state.snapshot().health.liveExecution, false);
    assert.deepEqual(state.snapshot().account.positions, []);
    const stored = { connectionId: 'generation-1', quote };
    const connection = { id: 'generation-1', active: true, updatedAt: NOW };
    assert.equal(usableStreamBook(stored, connection, NOW)?.receivedAt, NOW);
    assert.equal(usableStreamBook(stored, { ...connection, active: false }, NOW), null);
    assert.equal(usableStreamBook(stored, { ...connection, id: 'generation-2' }, NOW), null);
    assert.equal(usableStreamBook(stored, { ...connection, updatedAt: NOW + 15000 }, NOW + 15000), null);
    state.disconnected('market', 'stopped', 'Synthetic disconnect');
    assert.equal(state.quotes.get(slug)!.valid, false);
  }
});
