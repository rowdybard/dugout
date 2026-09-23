import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMarketDetail, type DetailSources} from '../lib/server/market-detail.ts';
import type {Book} from '../lib/market/types.ts';

// Synthetic section responses isolate availability behavior from API/network state.
const book:Book = {
  bids:[{price:0.38, quantity:10}],
  asks:[{price:0.40, quantity:20}],
  state:'MARKET_STATE_OPEN',
  time:'2026-09-23T12:00:00Z',
};
const points = [
  {time:1_790_164_800_000, price:0.35},
  {time:1_790_168_400_000, price:0.40},
];
const unavailable = async ():Promise<never> => {throw new Error('Unavailable test section');};
const sources = ():DetailSources => ({
  quote:async () => ({bid:0.37, ask:0.41, volume:50, state:'MARKET_STATE_OPEN', depth:25}),
  book:async () => book,
  history:async () => points,
  metadata:async () => ({question:'Synthetic test question', rules:'Synthetic test rules'}),
  activity:async () => [],
  replayAt:async () => undefined,
});

test('rules and activity failures preserve prices, history and executable offers', async () => {
  const result = await loadMarketDetail('test-market', '1h', {
    ...sources(), metadata:unavailable, activity:unavailable,
  });
  assert.deepEqual(result.history, points);
  assert.deepEqual(result.book, book);
  assert.equal(result.quote?.ask, 0.40, 'calculator and headline should use the same book');
  assert.equal(result.quote?.bid, 0.38);
  assert.equal(result.quote?.source, 'order-book');
  assert.equal(result.rules, null);
  assert(result.warnings.rules);
  assert(result.warnings.activity);
  assert.equal(result.warnings.quote, undefined);
});

test('an unavailable book preserves information while making execution unavailable', async () => {
  const result = await loadMarketDetail('test-market', '1h', {...sources(), book:unavailable});
  assert.deepEqual(result.history, points);
  assert.equal(result.quote?.ask, 0.41);
  assert.equal(result.quote?.source, 'summary-quote');
  assert.equal(result.book, null);
  assert(result.warnings.book);
  assert.equal(result.rules, 'Synthetic test rules');
});

test('an empty fresh book never borrows stale offers from the summary quote', async () => {
  const result = await loadMarketDetail('test-market', '15m', {
    ...sources(), book:async () => ({...book, bids:[], asks:[]}),
  });
  assert.equal(result.quote?.bid, null);
  assert.equal(result.quote?.ask, null);
  assert.equal(result.quote?.depth, 0, 'an observed empty book is distinct from unavailable depth');
  assert.deepEqual(result.book?.asks, []);
  assert.equal(result.range, '15m');
});

test('a total section outage returns explicit unavailable data without fabricated prices', async () => {
  const result = await loadMarketDetail('test-market', '24h', {
    quote:unavailable, book:unavailable, history:unavailable,
    metadata:unavailable, activity:unavailable, replayAt:unavailable,
  });
  assert.equal(result.slug, 'test-market');
  assert.equal(result.quote, null);
  assert.equal(result.book, null);
  assert.deepEqual(result.history, []);
  assert.deepEqual(result.activity, []);
  assert.equal(result.replayAt, undefined);
  assert.deepEqual(Object.keys(result.warnings).sort(), ['activity', 'book', 'history', 'quote', 'rules']);
});
