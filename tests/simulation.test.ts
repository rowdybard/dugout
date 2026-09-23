import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {simulationView} from '../lib/simulation/ledger.ts';
import {simulateBuy, sideBook} from '../lib/market/paper.ts';
import type {SimulationObservation, SimulationRun} from '../lib/simulation/types.ts';

const run = JSON.parse(readFileSync(new URL('../data/mlb-simulation-2026-09-23.json', import.meta.url), 'utf8')) as SimulationRun;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);

test('captured entries obey the $10 total and $2 per-game budgets, including fees and depth', () => {
  assert.equal(run.bankroll, 10);
  assert.ok(run.entries.length <= 5);
  assert.equal(new Set(run.entries.map(entry => entry.gameId)).size, run.entries.length);
  assert.ok(run.spent <= 10);
  assert.ok(run.cash >= 0);
  close(run.cash + run.spent, 10);
  close(run.entries.reduce((sum, entry) => sum + entry.amount, 0), run.spent);
  close(run.entries.reduce((sum, entry) => sum + entry.fee, 0), run.fees);
  for (const entry of run.entries) {
    assert.ok(entry.amount <= 2);
    assert.ok(entry.contracts > 0 && Number.isInteger(entry.contracts));
    const fill = simulateBuy(sideBook(entry.book, entry.side), entry.budget, entry.coefficient);
    assert.equal(fill.contracts, entry.contracts);
    close(fill.total, entry.amount);
    close(fill.fees, entry.fee);
  }
});

test('every captured entry belongs to today’s New York slate, precedes first pitch and follows observed movement', () => {
  const date = (value: string | number) => new Intl.DateTimeFormat('en-CA', {
    timeZone: run.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
  for (const entry of run.entries) {
    assert.equal(date(entry.start), run.date);
    assert.ok(entry.time < Date.parse(entry.start));
    assert.ok(entry.history.length >= 2);
    const first = entry.history[0], last = entry.history.at(-1)!;
    assert.ok(last.time - first.time >= 45 * 60000);
    assert.ok(entry.time - last.time < 5 * 60000);
    assert.ok(last.time <= entry.time);
    const delta = last.price - first.price;
    close(delta * 100, entry.movePoints);
    assert.equal(entry.side, delta > 0 ? 'YES' : 'NO');
    assert.equal(entry.book.state, 'MARKET_STATE_OPEN');
  }
});

test('reading final results repeatedly never double-credits cash or rewrites original entries', () => {
  const original = JSON.stringify(run);
  const observations = Object.fromEntries(run.entries.map((entry, index) => [entry.id, {
    checkedAt: run.completedAt + 10000, settlement: index % 2, settledAt: run.completedAt + 10000,
    mark: null, markedAt: null, error: null,
  } satisfies SimulationObservation]));
  const one = simulationView(run, observations, run.completedAt + 10000);
  const two = simulationView(run, observations, run.completedAt + 20000);
  close(one.summary.cash, two.summary.cash);
  close(one.summary.value!, two.summary.value!);
  close(one.summary.value!, run.cash + one.positions.reduce((sum, entry) => sum + (entry.payout ?? 0), 0));
  assert.equal(one.summary.pending, 0);
  assert.equal(one.summary.settled, run.entries.length);
  assert.equal(JSON.stringify(run), original);
});

test('YES and NO official fractional settlements use the correct contract payout', () => {
  const entry = run.entries[0];
  const smallRun: SimulationRun = {...run, entries: [
    {...entry, id: 'yes', side: 'YES', contracts: 4, amount: 1.5},
    {...entry, id: 'no', side: 'NO', contracts: 4, amount: 1.5},
  ], cash: 7, spent: 3};
  const observation: SimulationObservation = {checkedAt: 100, settlement: .25, settledAt: 100, mark: 999, markedAt: 10, error: null};
  const view = simulationView(smallRun, {yes: observation, no: observation}, 100);
  assert.equal(view.positions[0].payout, 1);
  assert.equal(view.positions[1].payout, 3);
  assert.equal(view.summary.cash, 11);
  assert.equal(view.summary.value, 11);
  assert.equal(view.summary.pnl, 1);
});

test('price estimates never resolve a result, and missing exit depth stays unavailable', () => {
  const entry = {...run.entries[0], entryLiquidation: null};
  const smallRun: SimulationRun = {...run, entries: [entry]};
  const unavailable = simulationView(smallRun, {}, run.completedAt);
  assert.equal(unavailable.positions[0].status, 'pending');
  assert.equal(unavailable.positions[0].payout, null);
  assert.equal(unavailable.summary.value, null);
  const observed = simulationView(smallRun, {[entry.id]: {
    checkedAt: 100, settlement: null, settledAt: null, mark: 0, markedAt: 100, error: null,
  }}, 100);
  assert.equal(observed.positions[0].status, 'pending');
  assert.equal(observed.positions[0].payout, null);
  assert.equal(observed.positions[0].currentValue, 0);
});
