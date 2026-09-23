import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateBuy, simulateSell, sideBook} from '../lib/market/paper.ts';
import {scan} from '../lib/market/scanner.ts';
import type {Book, Market} from '../lib/market/types.ts';

const closeEnough = (actual:number, expected:number) =>
  assert(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

// Synthetic test books only. These are accounting examples, never live game data.
test('a $10 YES practice round trip preserves cash and charges spread plus both fees', () => {
  const book:Book = {
    bids:[{price:0.38, quantity:100}],
    asks:[{price:0.40, quantity:100}],
    state:'MARKET_STATE_OPEN',
    time:'2026-09-23T12:00:00Z',
  };
  const entry = simulateBuy(book, 10);
  assert.equal(entry.contracts, 23);
  closeEnough(entry.total, 9.58364);
  closeEnough(entry.unused, 0.41636);

  const exit = simulateSell(book, entry.contracts);
  assert.equal(exit.complete, true);
  closeEnough(exit.net, 8.3633934);
  closeEnough(entry.unused + exit.net, 8.7797534);
  assert(entry.unused + exit.net < 10, 'unchanged prices cannot create a paper profit');
});

test('a $10 opposite-outcome round trip uses complementary executable prices', () => {
  const yes:Book = {
    bids:[{price:0.42, quantity:100}],
    asks:[{price:0.44, quantity:100}],
    state:'MARKET_STATE_OPEN',
    time:'2026-09-23T12:00:00Z',
  };
  const opposite = sideBook(yes, 'NO');
  const entry = simulateBuy(opposite, 10);
  assert.equal(entry.contracts, 16);
  closeEnough(entry.average, 0.58);
  closeEnough(entry.total, 9.5508832);
  const exit = simulateSell(opposite, entry.contracts);
  closeEnough(exit.average, 0.56);
  closeEnough(entry.unused + exit.net, 9.13512);
});

test('thin exit depth cannot be treated as a completed cash-out', () => {
  const book:Book = {
    bids:[{price:0.40, quantity:2}, {price:0.30, quantity:1}],
    asks:[{price:0.45, quantity:100}],
    state:'MARKET_STATE_OPEN',
    time:'2026-09-23T12:00:00Z',
  };
  const exit = simulateSell(book, 10, 0);
  assert.equal(exit.complete, false);
  closeEnough(exit.net, 1.1);
});

test('an explicitly zero fee stays zero on entry and exit', () => {
  const book:Book = {
    bids:[{price:0.38, quantity:100}],
    asks:[{price:0.40, quantity:100}],
    state:'MARKET_STATE_OPEN',
    time:'2026-09-23T12:00:00Z',
  };
  const entry = simulateBuy(book, 10, 0);
  const exit = simulateSell(book, entry.contracts, 0);
  assert.equal(entry.contracts, 25);
  assert.equal(entry.fees, 0);
  assert.equal(exit.fees, 0);
  closeEnough(entry.unused + exit.net, 9.5);
});

test('outdated observations and missing spreads do not create movement alerts', () => {
  const now = Date.now();
  const stale = {
    bid:null,
    ask:null,
    history:[
      {time:now - 8_000_000, price:0.1, spread:0.08},
      {time:now - 7_000_000, price:0.5, spread:0.02},
      {time:now - 6_000_000, price:0.9, spread:0.01},
    ],
  } as Market;
  assert.deepEqual(scan(stale), []);
  const incomplete = {
    ...stale,
    history:[
      {time:now - 1_800_000, price:0.4},
      {time:now - 900_000, price:0.4, spread:0.01},
      {time:now, price:0.4, spread:0.08},
    ],
  } as Market;
  assert.deepEqual(scan(incomplete), []);
});
