import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTennisAction, createTennisSession, defaultTennisConfig, stepTennisSession, tennisEquity, validateTennisConfig } from '../lib/tennis/engine.ts';
import type { TennisInput, TennisSession } from '../lib/tennis/types';

// Entirely synthetic execution experiments; no fabricated game is exposed by the app.
const epoch = Date.parse('2026-09-25T18:00:00Z');
const round = (n: number) => Math.round(n * 1e6) / 1e6;
function input(time: number, bid = 0.49, ask = 0.50, bidSize = 1000, askSize = 1000): TennisInput {
  return {
    market: { slug: 'synthetic-tennis', eventId: 'fixture', eventSlug: 'fixture', title: 'Synthetic A vs Synthetic B', league: 'ATP',
      yesName: 'Synthetic A', noName: 'Synthetic B', startTime: new Date(epoch).toISOString(), live: true, ended: false,
      score: null, period: null, tournament: null, active: true, bid, ask, price: (bid + ask) / 2, observedAt: time,
      contextUpdatedAt: null, history: [], execution: { slug: 'synthetic-tennis', league: 'ATP', active: true,
        minimumTradeQty: 1, quantityIncrement: 1, priceIncrement: 0.01, feeCoefficient: 0.05 } },
    book: { bids: [{ price: bid, quantity: bidSize }], asks: [{ price: ask, quantity: askSize }],
      state: 'MARKET_STATE_OPEN', time: new Date(time).toISOString() }, receivedAt: time, source: 'REST',
  };
}
function started(): TennisSession {
  return applyTennisAction(createTennisSession(defaultTennisConfig(), epoch), { action: 'start', commandId: 'start' }, [], epoch);
}
function entered(config=defaultTennisConfig()): TennisSession {
  let session=applyTennisAction(createTennisSession(config,epoch-48000),{action:'start',commandId:'start'},[],epoch-48000);
  for(let i=0;i<11;i++){const t=epoch-48000+i*4000;session=stepTennisSession(session,[input(t,.59,.60)],t);}
  for(const [offset,bid,ask] of [[-6000,.45,.46],[-4000,.48,.49],[-2000,.49,.50]]){
    session=stepTennisSession(session,[input(epoch+offset,bid,ask)],epoch+offset);
  }
  return stepTennisSession(session,[input(epoch+1000)],epoch+1000);
}
function conserved(session: TennisSession) {
  assert.equal(round(session.config.startingCash + session.ledger.reduce((sum, entry) => sum + entry.cashDelta, 0)), session.cash);
  assert.ok(session.cash >= 0);
  const closed = session.positions.filter(position => position.status !== 'open');
  if (closed.length === session.positions.length) assert.equal(round(session.cash - session.config.startingCash), round(closed.reduce((sum, position) => sum + position.realizedPnl, 0)));
}

test('start cannot be reused to overwrite a running balance or rules', () => {
  assert.equal(validateTennisConfig(defaultTennisConfig()), null);
  assert.ok(validateTennisConfig({ ...defaultTennisConfig(), executionDelayMs: 0 }));
  assert.match(validateTennisConfig({ ...defaultTennisConfig(), startingCash: 1001 })!, /balance/);
  assert.match(validateTennisConfig({ ...defaultTennisConfig(), entryBudget: 50 })!, /20%/);
  let session = applyTennisAction(createTennisSession(defaultTennisConfig(), epoch), { action: 'start', commandId: 'start', config: { entryBudget: 10 } }, [], epoch);
  assert.equal(session.config.entryBudget, 10);
  session = applyTennisAction(session, { action: 'start', commandId: 'change', config: { targetReturn: 0.5 } }, [], epoch + 1);
  assert.equal(session.config.targetReturn, 0.03);
  assert.match(session.lastReason, /already exists/);
});

test('net target closes a profitable round trip with both fees and actual delayed-book evidence', () => {
  let session = entered();
  const position = session.positions[0];
  assert.equal(position.quantity, 9);
  assert.equal(position.entryFees, 0.11);
  session = stepTennisSession(session, [input(epoch + 2000, 0.55, 0.56)], epoch + 2000);
  assert.equal(session.pending?.action, 'SELL');
  assert.equal(session.cash, 95.39);
  session = stepTennisSession(session, [input(epoch + 3000, 0.55, 0.56)], epoch + 3000);
  assert.equal(session.positions[0].status, 'closed');
  assert.equal(session.positions[0].proceeds, 4.84);
  assert.equal(session.positions[0].realizedPnl, 0.23);
  assert.equal(session.cash, 100.23);
  assert.equal(tennisEquity(session), 100.23);
  assert.equal(session.ledger[1].quotedPrice, 0.55);
  assert.equal(session.ledger[1].actualPrice, 0.55);
  assert.equal(session.ledger[1].executionDelayMs, 1000);
  assert.equal(session.ledger[1].signalBookTime, epoch + 2000);
  assert.equal(session.ledger[1].executionBookTime, epoch + 3000);
  conserved(session);
});

test('a falling market never becomes an automatic buy simply because the drop is large', () => {
  let session = started();
  for (let index = 0; index < 11; index++) session = stepTennisSession(session, [input(epoch + index * 4000, 0.59, 0.60)], epoch + index * 4000);
  for (let index = 0; index < 8; index++) session = stepTennisSession(session, [input(epoch + 44_000 + index * 2000, round(0.55 - index * 0.01), round(0.56 - index * 0.01))], epoch + 44_000 + index * 2000);
  assert.equal(session.positions.length, 0);
  assert.equal(session.pending, null);
  assert.equal(session.cash, 100);
  assert.ok(session.decisions.some(decision => decision.code === 'FALLING'));
});

test('a recovery with too little room to pay both fees and the target is rejected', () => {
  let session = started();
  for (let index = 0; index < 11; index++) session = stepTennisSession(session, [input(epoch + index * 4000, 0.59, 0.60)], epoch + index * 4000);
  session = stepTennisSession(session, [input(epoch + 44_000, 0.55, 0.56)], epoch + 44_000);
  session = stepTennisSession(session, [input(epoch + 46_000, 0.57, 0.58)], epoch + 46_000);
  session = stepTennisSession(session, [input(epoch + 48_000, 0.57, 0.58)], epoch + 48_000);
  assert.equal(session.pending, null);
  assert.equal(session.positions.length, 0);
  assert.ok(session.rejectionCounts.COST_HEADROOM > 0);
});

test('target exits stay requested after partial execution even if the remaining price subsequently falls', () => {
  let session = entered();
  session = stepTennisSession(session, [input(epoch + 2000, 0.55, 0.56)], epoch + 2000);
  session = stepTennisSession(session, [input(epoch + 3000, 0.55, 0.56, 3)], epoch + 3000);
  assert.equal(session.positions[0].quantity, 6);
  assert.equal(session.ledger[1].execution?.status, 'partial');
  assert.ok(session.exitRequested);
  const cash = session.cash;
  session = stepTennisSession(session, [input(epoch + 3000, 0.55, 0.56, 3)], epoch + 3100);
  assert.equal(session.cash, cash);
  assert.equal(session.pending, null);
  session = stepTennisSession(session, [input(epoch + 4000, 0.51, 0.52)], epoch + 4000);
  assert.equal(session.pending?.action, 'SELL', 'exit request survives a move below the original profit target');
  session = stepTennisSession(session, [input(epoch + 5000, 0.51, 0.52)], epoch + 5000);
  assert.equal(session.positions[0].status, 'closed');
  assert.equal(session.exitRequested, undefined);
  conserved(session);
});

test('an unfavorable later book cannot invent an earlier fill; an unfilled exit retries at a fresh limit', () => {
  let session = entered();
  session = stepTennisSession(session, [input(epoch + 2000, 0.55, 0.56)], epoch + 2000);
  session = stepTennisSession(session, [input(epoch + 3000, 0.52, 0.53)], epoch + 3000);
  assert.equal(session.ledger[1].execution?.status, 'unfilled');
  assert.equal(session.positions[0].quantity, 9);
  assert.equal(session.cash, 95.39);
  session = stepTennisSession(session, [input(epoch + 4000, 0.48, 0.49)], epoch + 4000);
  assert.equal(session.pending?.limitPrice, 0.48);
  session = stepTennisSession(session, [input(epoch + 5000, 0.48, 0.49)], epoch + 5000);
  assert.equal(session.positions[0].status, 'closed');
  assert.ok(session.cash < 100);
  conserved(session);
});

test('paused entries, missing tennis context and absent asks do not prevent an executable loss exit', () => {
  let session = entered();
  session = applyTennisAction(session, { action: 'pause', commandId: 'pause' }, [], epoch + 1500);
  let book = input(epoch + 2000, 0.42, 0.43);
  book.book.asks = [];
  book.market.active = false; // Catalog may no longer consider this suitable for new entries.
  session = stepTennisSession(session, [book], epoch + 2000);
  assert.equal(session.pending?.action, 'SELL');
  book = { ...book, receivedAt: epoch + 3000 };
  session = stepTennisSession(session, [book], epoch + 3000);
  assert.equal(session.positions[0].status, 'closed');
  assert.ok(session.cash < 100);
  assert.equal(session.status, 'paused');
  conserved(session);
});

test('time exit does not fabricate a sale when buyers disappear, and recovers when they return', () => {
  let session = entered();
  const noBuyers = input(epoch + 125_000);
  noBuyers.book.bids = [];
  session = stepTennisSession(session, [noBuyers], epoch + 125_000);
  assert.equal(session.positions[0].status, 'open');
  assert.equal(session.positions[0].netLiquidationValue, null);
  assert.equal(session.cash, 95.39);
  session = stepTennisSession(session, [input(epoch + 126_000)], epoch + 126_000);
  assert.equal(session.pending?.action, 'SELL');
  session = stepTennisSession(session, [input(epoch + 127_000)], epoch + 127_000);
  assert.equal(session.positions[0].status, 'closed');
  conserved(session);
});

test('bot stop remains requested when its source feed is unavailable', () => {
  let session = entered();
  session = applyTennisAction(session, { action: 'stop', commandId: 'stop' }, [], epoch + 2000);
  assert.equal(session.status, 'stopping');
  assert.equal(session.positions[0].status, 'open');
  session = stepTennisSession(session, [input(epoch + 3000)], epoch + 3000);
  assert.equal(session.pending?.action, 'SELL');
  session = stepTennisSession(session, [input(epoch + 4000)], epoch + 4000);
  assert.equal(session.status, 'stopped');
  assert.equal(session.positions[0].status, 'closed');
  conserved(session);
});

test('an ended or replay market never opens a new paper position', () => {
  for (const mode of ['ended', 'replay'] as const) {
    const book = input(epoch);
    if (mode === 'ended') book.market.ended = true;
    else book.source = 'REPLAY';
    const session = stepTennisSession(started(), [book], epoch);
    assert.equal(session.pending, null);
    assert.equal(session.positions.length, 0);
    assert.equal(session.cash, 100);
  }
});

test('confirmed settlement loss stops the session and the loss limit cannot be resumed', () => {
  let session = entered({...defaultTennisConfig(),entryBudget:20,maxSessionLossFraction:.1});
  const final = input(epoch + 2000);
  final.market.ended = true; final.market.active = false; final.settlement = 0; final.settlementReceivedAt = epoch + 2000;
  session = stepTennisSession(session, [final], epoch + 2000);
  assert.equal(session.status, 'stopped');
  assert.ok(session.cash < 90);
  session = applyTennisAction(session, { action: 'pause', commandId: 'pause' }, [], epoch + 3000);
  session = applyTennisAction(session, { action: 'resume', commandId: 'resume' }, [], epoch + 4000);
  assert.equal(session.status, 'stopped');
  conserved(session);
});

test('decision IDs stay unique after the display buffer fills so the persistent journal loses no decisions', () => {
  let session = started();
  for (let index = 0; index < 200; index++) session = stepTennisSession(session, [input(epoch + index * 1000)], epoch + index * 1000);
  assert.equal(session.decisions.length, 300);
  assert.equal(new Set(session.decisions.map(decision => decision.id)).size, 300);
  assert.equal(session.decisionSequence, 400);
});
