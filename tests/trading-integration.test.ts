import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {executePaperCommand} from '../lib/trading/execution.ts';
import {applyPaperExecution, takeManualControl} from '../lib/trading/ledger.ts';
import {DEFAULT_CONFIG} from '../lib/market/scanner.ts';
import {
  DEFAULT_DIP_REVERSION, evaluateDipReversion, initialDipReversionState, recordStrategyExecution,
} from '../lib/trading/strategy.ts';
import {StreamState} from '../services/trading/state.ts';
import type {Book, Market, Profile} from '../lib/market/types.ts';
import type {
  ExecutionMarket,
  ExecutionPolicy,
  PaperAccount,
  PaperCommand,
  PaperCommandRecord,
  DipReversionConfig,
  DipReversionInput,
} from '../lib/trading/types.ts';

// Entirely synthetic engineering scenarios. These are not current games, paper
// experiment returns, historical market observations, or strategy evidence.
const NOW = Date.parse('2026-09-23T18:00:00.000Z');
const market: ExecutionMarket = {
  slug: 'synthetic-mlb-winner', league: 'MLB', active: true,
  minimumTradeQty: 1, quantityIncrement: 1, priceIncrement: 0.01,
  feeCoefficient: 0.0695,
};
const account = (changes: Partial<PaperAccount> = {}): PaperAccount => ({
  cash: 10, marketExposure: 0, totalExposure: 0, availableQuantity: 0,
  ...changes,
});
const policy = (changes: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  now: NOW, bookReceivedAt: NOW, bookSource: 'REST', stateCertain: true,
  maxBookAgeMs: 5_000, maxCommandAgeMs: 10_000,
  maxOrderBudget: 25, maxMarketExposure: 50, maxTotalExposure: 100,
  automation: 'PAPER', ...changes,
});
let nextId = 0;
const command = (changes: Partial<PaperCommand> = {}): PaperCommand => ({
  commandId: `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
  marketSlug: market.slug, side: 'YES', action: 'BUY', source: 'MANUAL',
  budget: 10, limitPrice: 0.40, createdAt: NOW, ...changes,
});
const book = (bid = 0.38, ask = 0.40, changes: Partial<Book> = {}): Book => ({
  bids: [{price: bid, quantity: 100}], asks: [{price: ask, quantity: 100}],
  state: 'MARKET_STATE_OPEN', time: new Date(NOW).toISOString(), ...changes,
});
const close = (actual: number, expected: number, tolerance = 0.000001) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test('synthetic $10 round trip: a 40¢ to 42¢ rebound still loses after both taker fees', () => {
  const entry = executePaperCommand(command(), account(), market, book(), policy());
  assert.equal(entry.status, 'filled');
  assert.equal(entry.apply, true);
  assert.ok(entry.filledQty > 0);
  assert.ok(-entry.cashDelta <= 10, 'the entry budget includes estimated fees');
  assert.ok(entry.fees > 0);

  const exit = executePaperCommand(command({
    action: 'SELL', budget: undefined, quantity: entry.filledQty, limitPrice: 0.42,
  }), account({cash: 10 + entry.cashDelta, availableQuantity: entry.filledQty}),
  market, book(0.42, 0.44), policy());

  assert.equal(exit.status, 'filled');
  close(exit.averagePrice, 0.42);
  assert.ok(exit.fees > 0);
  const finalCash = 10 + entry.cashDelta + exit.cashDelta;
  assert.ok(finalCash < 10, 'a higher chart price cannot hide round-trip trading costs');
  close(finalCash - 10, entry.filledQty * 0.02 - entry.fees - exit.fees);
});

test('synthetic latency: a quote moving beyond the entry limit cannot fill at its old price', () => {
  const intent = command({limitPrice: 0.41});
  const delayed = executePaperCommand(intent, account(), market, book(0.43, 0.44), policy({
    now: NOW + 250, bookReceivedAt: NOW + 240,
  }));
  assert.equal(delayed.filledQty, 0);
  assert.equal(delayed.cashDelta, 0);
  assert.equal(delayed.apply, false);
  assert.equal(delayed.fills.length, 0);
});

test('synthetic thin IOC entry fills available size and cancels the quantity beyond the limit', () => {
  const result = executePaperCommand(command({limitPrice: 0.41}), account(), market, book(0.38, 0.40, {
    asks: [{price: 0.40, quantity: 2}, {price: 0.45, quantity: 100}],
  }), policy());
  assert.equal(result.status, 'partial');
  assert.equal(result.filledQty, 2);
  assert.ok(result.remainingQty > 0);
  assert.ok(result.fills.every(fill => fill.price <= 0.41));
  close(result.gross, 0.80);
  close(result.cashDelta, -result.gross - result.fees);
  close(result.unusedBudget, 10 + result.cashDelta);
});

test('synthetic fractional market sizes on its declared increment without exceeding a fee-inclusive budget', () => {
  const fractional: ExecutionMarket = {...market, minimumTradeQty: 0.001, quantityIncrement: 0.001};
  const result = executePaperCommand(command({budget: 9.99}), account(), fractional, book(), policy());
  assert.equal(result.status, 'filled');
  assert.ok(result.filledQty > 23 && result.filledQty < 25);
  assert.equal(Number.isInteger(result.filledQty), false);
  close(result.filledQty * 1_000, Math.round(result.filledQty * 1_000));
  assert.ok(-result.cashDelta <= 9.99);
  assert.ok(result.unusedBudget >= 0);
  close(-result.cashDelta + result.unusedBudget, 9.99);
});

test('synthetic partial exit reports the filled average and leaves the rest held', () => {
  const result = executePaperCommand(command({
    action: 'SELL', budget: undefined, quantity: 10, limitPrice: 0.35,
  }), account({availableQuantity: 10}), market, book(0.38, 0.40, {
    bids: [{price: 0.38, quantity: 3}],
  }), policy());
  assert.equal(result.status, 'partial');
  assert.equal(result.filledQty, 3);
  assert.equal(result.remainingQty, 7);
  close(result.averagePrice, 0.38, 0.00001);
  close(result.gross, 1.14);
  close(result.cashDelta, result.gross - result.fees);
});

test('synthetic NO outcome uses complementary executable sides and keeps a positive spread', () => {
  const yesBook = book(0.61, 0.65);
  const entry = executePaperCommand(command({side: 'NO', limitPrice: 0.39}),
    account(), market, yesBook, policy());
  assert.ok(entry.filledQty > 0);
  close(entry.averagePrice, 0.39);
  const exit = executePaperCommand(command({
    side: 'NO', action: 'SELL', budget: undefined,
    quantity: entry.filledQty, limitPrice: 0.35,
  }), account({availableQuantity: entry.filledQty}), market, yesBook, policy());
  assert.equal(exit.filledQty, entry.filledQty);
  close(exit.averagePrice, 0.35);
  assert.ok(entry.averagePrice > exit.averagePrice);
  assert.ok(entry.cashDelta + exit.cashDelta < 0);
});

test('synthetic freshness: stale snapshots, replay and uncertain state cannot spend money', () => {
  for (const settings of [
    policy({bookReceivedAt: NOW - 5_001}),
    policy({bookSource: 'REPLAY'}),
    policy({stateCertain: false}),
    policy({bookReceivedAt: NOW + 1}),
  ]) {
    const result = executePaperCommand(command(), account(), market, book(), settings);
    assert.equal(result.status, 'rejected');
    assert.equal(result.filledQty, 0);
    assert.equal(result.cashDelta, 0);
    assert.equal(result.apply, false);
  }
});

test('a just-received authoritative snapshot stays eligible when its last price change was old', () => {
  const result = executePaperCommand(command(), account(), market,
    book(0.38, 0.40, {time: new Date(NOW - 60 * 60_000).toISOString()}), policy());
  assert.ok(result.filledQty > 0, 'provider transaction time is not snapshot receipt time');
});

test('synthetic empty offers never borrow a quote from history or invent a fill', () => {
  const result = executePaperCommand(command(), account(), market,
    book(0.38, 0.40, {asks: []}), policy());
  assert.equal(result.filledQty, 0);
  assert.equal(result.cashDelta, 0);
  assert.equal(result.apply, false);
});

test('synthetic malformed prices and crossed books fail closed instead of creating attractive fills', () => {
  for (const input of [
    book(0.45, 0.40),
    book(0.38, 0.40, {asks: [{price: Number.NaN, quantity: 100}]}),
    book(0.38, 0.40, {asks: [{price: 0.40, quantity: -1}]}),
    book(0.38, 0.40, {asks: [{price: 0.40000001, quantity: 100}]}),
  ]) {
    const result = executePaperCommand(command(), account(), market, input, policy());
    assert.equal(result.status, 'rejected');
    assert.equal(result.filledQty, 0);
    assert.equal(result.apply, false);
  }
});

test('replaying a finalized command preserves its result without applying cash twice', () => {
  const intent = command();
  const first = executePaperCommand(intent, account(), market, book(), policy());
  const prior: PaperCommandRecord = {
    commandId: intent.commandId, fingerprint: first.fingerprint, state: 'final', result: first,
  };
  const again = executePaperCommand(intent, account({cash: 10 + first.cashDelta}),
    market, book(), policy(), prior);
  assert.equal(again.replayed, true);
  assert.equal(again.apply, false);
  assert.equal(again.cashDelta, 0);
  assert.equal(again.filledQty, first.filledQty);

  const collision = executePaperCommand({...intent, budget: 5}, account(), market, book(), policy(), prior);
  assert.equal(collision.status, 'rejected');
  assert.equal(collision.apply, false);
  assert.equal(collision.cashDelta, 0);
});

test('pending and unknown command outcomes remain unresolved instead of causing duplicate entry', () => {
  const intent = command();
  const fingerprint = executePaperCommand(intent, account(), market, book(), policy()).fingerprint;
  for (const state of ['pending', 'unknown'] as const) {
    const result = executePaperCommand(intent, account(), market, book(), policy(), {
      commandId: intent.commandId, fingerprint, state,
    });
    assert.equal(result.status, 'unknown');
    assert.equal(result.apply, false);
    assert.equal(result.cashDelta, 0);
    assert.equal(result.filledQty, 0);
  }
});

test('manual takeover blocks a queued automatic entry while permitting the manual exit', () => {
  const takenOver = policy({manualTakeover: true});
  const automatic = executePaperCommand(command({source: 'AUTOMATIC', strategyVersion: 'synthetic-v1'}),
    account(), market, book(), takenOver);
  assert.equal(automatic.status, 'rejected');
  assert.equal(automatic.apply, false);
  const exit = executePaperCommand(command({
    action: 'SELL', budget: undefined, quantity: 3, limitPrice: 0.38,
  }), account({availableQuantity: 3}), market, book(), takenOver);
  assert.equal(exit.filledQty, 3);
  assert.equal(exit.apply, true);
});

test('synthetic exits cannot sell more than available holdings or bypass a price floor', () => {
  const oversized = executePaperCommand(command({
    action: 'SELL', budget: undefined, quantity: 10, limitPrice: 0.38,
  }), account({availableQuantity: 3}), market, book(), policy());
  assert.equal(oversized.status, 'rejected');
  assert.equal(oversized.cashDelta, 0);
  const protectedExit = executePaperCommand(command({
    action: 'SELL', budget: undefined, quantity: 3, limitPrice: 0.40,
  }), account({availableQuantity: 3}), market, book(), policy());
  assert.equal(protectedExit.filledQty, 0);
  assert.equal(protectedExit.cashDelta, 0);
});

const streamBook = (sourceTime = NOW - 1_000, bid = '0.38', ask = '0.40') => ({
  requestId: 'synthetic-subscription', subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA',
  marketData: {
    marketSlug: market.slug, state: 'MARKET_STATE_OPEN',
    bids: [{px: {value: bid, currency: 'USD'}, qty: '100'}],
    offers: [{px: {value: ask, currency: 'USD'}, qty: '100'}],
    stats: {lastTradePx: {value: '0.39', currency: 'USD'}},
    transactTime: new Date(sourceTime).toISOString(),
  },
});
const connectedState = (clock: () => number) => {
  const state = new StreamState(true, clock);
  state.setSelections([{slug: market.slug, league: 'MLB', detail: 'book'}]);
  state.connected('market');
  return state;
};

test('synthetic quiet stream: heartbeats preserve health without inventing price changes or snapshot times', () => {
  let clock = NOW;
  const state = connectedState(() => clock);
  assert.equal(state.ingestMarket(streamBook()), true);
  const before = state.snapshot().quotes[0];
  clock += 20_000;
  assert.equal(state.ingestMarket({heartbeat: {}}), true);
  assert.deepEqual(state.checkHealth(5_000), []);
  const after = state.snapshot().quotes[0];
  assert.equal(after.valid, true);
  assert.equal(after.receivedAt, before.receivedAt);
  assert.equal(after.lastPriceChangeAt, before.lastPriceChangeAt);
  assert.equal(after.sourceTime, NOW - 1_000);
  assert.equal(state.health.market.lastHeartbeatAt, clock);
});

test('synthetic reconnect: a heartbeat cannot make an uncertain old book executable', () => {
  let clock = NOW;
  const state = connectedState(() => clock);
  state.ingestMarket(streamBook());
  state.disconnected('market', 'reconnecting', 'Synthetic transport loss');
  assert.equal(state.snapshot().quotes[0].valid, false);
  clock += 100;
  state.connected('market');
  state.ingestMarket({heartbeat: {}});
  assert.equal(state.snapshot().quotes[0].valid, false);
  const blocked = executePaperCommand(command(), account(), market, book(), policy({
    stateCertain: state.snapshot().quotes[0].valid,
  }));
  assert.equal(blocked.filledQty, 0);
  assert.equal(blocked.apply, false);

  state.ingestMarket(streamBook(NOW + 50));
  assert.equal(state.snapshot().quotes[0].valid, true);
});

test('synthetic out-of-order book does not replace a more recent quote or refresh its age', () => {
  let clock = NOW;
  const state = connectedState(() => clock);
  state.ingestMarket(streamBook(NOW - 500));
  const before = state.snapshot().quotes[0];
  clock += 1_000;
  assert.equal(state.ingestMarket(streamBook(NOW - 1_000, '0.10', '0.12')), false);
  assert.deepEqual(state.snapshot().quotes[0], before);
});

test('synthetic source clock lead is bounded and never overwrites server receipt time', () => {
  const state = connectedState(() => NOW);
  assert.equal(state.ingestMarket(streamBook(NOW + 1_000)), true);
  assert.equal(state.snapshot().quotes[0].sourceTime, NOW + 1_000);
  assert.equal(state.snapshot().quotes[0].receivedAt, NOW);
  assert.equal(state.ingestMarket(streamBook(NOW + 2_001)), false);
  assert.equal(state.snapshot().quotes[0].valid, false,
    'source time beyond the documented clock allowance invalidates the current book');
});

test('synthetic protocol gap invalidates the book; legacy/global envelopes cannot become US quotes', () => {
  const state = connectedState(() => NOW);
  state.ingestMarket(streamBook());
  assert.equal(state.ingestMarket({event_type: 'book', asset_id: 'synthetic-token', bids: [], asks: []}), false);
  assert.equal(state.snapshot().quotes[0].valid, false);
  assert.equal(state.health.market.rejectedMessages, 1);
  assert.equal(state.snapshot().quotes[0].ask, 0.40, 'last known display stays visible but invalid');
});

test('synthetic private-event race prevents an older REST account snapshot from being marked reconciled', () => {
  const state = connectedState(() => NOW);
  state.connected('private');
  const revision = state.accountRevision;
  assert.equal(state.ingestPrivate({
    requestId: 'synthetic-account', subscriptionType: 'SUBSCRIPTION_TYPE_ACCOUNT_BALANCE',
    accountBalancesUpdate: {balanceChange: {
      afterBalance: {currency: 'USD', currentBalance: 8, buyingPower: 8},
      updateTime: new Date(NOW).toISOString(),
    }},
  }), true);
  assert.equal(state.reconciled({
    positions: [], orders: [], balances: [{currency: 'USD', currentBalance: '10', buyingPower: '10'}],
    reconciledAt: null,
  }, revision), false);
  assert.equal(state.health.reconciliation.state, 'pending');
  assert.equal(state.account.balances[0].currentBalance, '8');
});

const strategyConfig: DipReversionConfig = {
  ...DEFAULT_DIP_REVERSION, version: 'synthetic-integration-v1',
  baselineWindowMs: 60_000, minimumHistoryMs: 20_000, minSamples: 4,
  declinePoints: 5, recoveryPoints: 1, recoveryConfirmations: 2,
  minimumDepth: 1, entryBudget: 5, limitOffsetPoints: 0,
  targetReturn: 0.05, stopReturn: 0.30,
};
const dipHistory = [
  {time: NOW - 30_000, price: 0.60},
  {time: NOW - 20_000, price: 0.60},
  {time: NOW - 10_000, price: 0.60},
  {time: NOW, price: 0.50},
];
const strategyInput = (changes: Partial<DipReversionInput> = {}): DipReversionInput => ({
  now: NOW, market, side: 'YES', book: book(0.48, 0.50),
  policy: policy(), account: account(), gamePhase: 'PREGAME', history: dipHistory,
  ...changes,
});
const recoveryTick = (offset: number, ask: number, changes: Partial<DipReversionInput> = {}) => strategyInput({
  now: NOW + offset,
  policy: policy({now: NOW + offset, bookReceivedAt: NOW + offset}),
  book: book(Number((ask - 0.02).toFixed(2)), ask),
  history: [...dipHistory, {time: NOW + offset, price: ask}],
  ...changes,
});

test('synthetic dip replay has no lookahead and a decline alone never emits an entry', () => {
  const initial = initialDipReversionState(strategyConfig);
  const clean = evaluateDipReversion(strategyConfig, initial, strategyInput());
  const contaminated = evaluateDipReversion(strategyConfig, initial, strategyInput({
    history: [...dipHistory,
      {time: NOW + 1, price: 0.99}, {time: NOW + 2, price: 0.98},
      {time: NOW + 3, price: 0.97}, {time: NOW + 4, price: 0.96}],
  }));
  assert.deepEqual(contaminated, clean, 'future prices cannot change the decision at NOW');
  assert.equal(clean.state.phase, 'DIP');
  assert.equal(clean.decision.action, 'WAIT');

  const repeated = evaluateDipReversion(strategyConfig, clean.state, strategyInput());
  assert.equal(repeated.decision.action, 'WAIT');
  assert.equal(repeated.state.recoveryCount, 0, 'reading the same observation twice adds no confirmation');
  const falling = evaluateDipReversion(strategyConfig, clean.state, recoveryTick(1_000, 0.47));
  assert.equal(falling.decision.action, 'WAIT');
  assert.equal(falling.state.trough, 0.47);
});

test('synthetic dip replay: independent recovery, fee-aware hold, partial target exit, then cooldown', () => {
  const dip = evaluateDipReversion(strategyConfig, initialDipReversionState(strategyConfig), strategyInput());
  const firstRecovery = evaluateDipReversion(strategyConfig, dip.state, recoveryTick(1_000, 0.52));
  assert.equal(firstRecovery.decision.action, 'WAIT');
  const buyDecision = evaluateDipReversion(strategyConfig, firstRecovery.state, recoveryTick(2_000, 0.52));
  assert.equal(buyDecision.decision.action, 'BUY');
  const pending = evaluateDipReversion(strategyConfig, buyDecision.state, recoveryTick(3_000, 0.53));
  assert.equal(pending.decision.action, 'WAIT', 'a signal cannot submit twice while its fill is unknown');

  const buy = executePaperCommand(command({
    source: 'AUTOMATIC', strategyVersion: strategyConfig.version,
    budget: buyDecision.decision.budget, limitPrice: buyDecision.decision.limitPrice!, createdAt: NOW + 2_000,
  }), account(), market, book(0.50, 0.52), policy({now: NOW + 2_000, bookReceivedAt: NOW + 2_000}));
  assert.equal(buy.status, 'filled');
  const basis = -buy.cashDelta;
  const held = recordStrategyExecution(strategyConfig, buyDecision.state, buy, buy.filledQty);
  assert.equal(held.phase, 'HOLDING');
  const heldAccount = account({cash: 10 - basis, availableQuantity: buy.filledQty,
    marketExposure: basis, totalExposure: basis});
  const heldPosition = {quantity: buy.filledQty, costBasis: basis, openedAt: NOW + 2_000};

  const littleRebound = evaluateDipReversion(strategyConfig, held, recoveryTick(3_000, 0.56, {
    account: heldAccount, position: heldPosition,
  }));
  assert.equal(littleRebound.decision.action, 'WAIT');
  assert.ok(littleRebound.decision.estimatedNetReturn! < 0,
    'a higher executable bid still falls short after entry and exit costs');

  const thinTargetBook = book(0.62, 0.64, {bids: [{price: 0.62, quantity: 3}]});
  const target = evaluateDipReversion(strategyConfig, held, recoveryTick(4_000, 0.64, {
    book: thinTargetBook, account: heldAccount, position: heldPosition,
  }));
  assert.equal(target.decision.action, 'SELL');
  assert.equal(target.decision.exitReason, 'TARGET');
  const partial = executePaperCommand(command({
    source: 'AUTOMATIC', strategyVersion: strategyConfig.version, action: 'SELL', budget: undefined,
    quantity: target.decision.quantity, limitPrice: target.decision.limitPrice!, createdAt: NOW + 4_000,
  }), heldAccount, market, thinTargetBook, policy({now: NOW + 4_000, bookReceivedAt: NOW + 4_000}));
  assert.equal(partial.status, 'partial');
  assert.equal(partial.filledQty, 3);
  const remainder = buy.filledQty - partial.filledQty;
  const afterPartial = recordStrategyExecution(strategyConfig, target.state, partial, remainder);
  assert.equal(afterPartial.phase, 'HOLDING', 'a partial exit cannot put the whole position into cooldown');
  const remainingBasis = Math.round(basis * remainder / buy.filledQty * 1_000_000) / 1_000_000;
  const secondAccount = account({cash: 10 - basis + partial.cashDelta,
    availableQuantity: remainder, marketExposure: remainingBasis, totalExposure: remainingBasis});
  const nextExit = evaluateDipReversion(strategyConfig, afterPartial, recoveryTick(5_000, 0.64, {
    account: secondAccount,
    position: {quantity: remainder, costBasis: remainingBasis, openedAt: heldPosition.openedAt},
  }));
  assert.equal(nextExit.decision.action, 'SELL');
  const finalExit = executePaperCommand(command({
    source: 'AUTOMATIC', strategyVersion: strategyConfig.version, action: 'SELL', budget: undefined,
    quantity: remainder, limitPrice: nextExit.decision.limitPrice!, createdAt: NOW + 5_000,
  }), secondAccount, market, book(0.62, 0.64), policy({now: NOW + 5_000, bookReceivedAt: NOW + 5_000}));
  assert.equal(finalExit.status, 'filled');
  const cooled = recordStrategyExecution(strategyConfig, nextExit.state, finalExit, 0);
  assert.equal(cooled.phase, 'COOLDOWN');
  assert.equal(evaluateDipReversion(strategyConfig, cooled, recoveryTick(6_000, 0.52)).decision.action, 'WAIT');
});

test('synthetic missing quotes and manual takeover cannot turn an armed dip into re-entry', () => {
  const dip = evaluateDipReversion(strategyConfig, initialDipReversionState(strategyConfig), strategyInput());
  const unavailable = evaluateDipReversion(strategyConfig, dip.state, recoveryTick(1_000, 0.52, {
    book: book(0.50, 0.52, {asks: []}),
  }));
  assert.equal(unavailable.decision.action, 'WAIT');
  const manual = evaluateDipReversion(strategyConfig, dip.state, strategyInput({
    policy: policy({manualTakeover: true}),
  }));
  assert.equal(manual.decision.action, 'PAUSE');
  assert.equal(manual.state.phase, 'PAUSED');
  const stillPaused = evaluateDipReversion(strategyConfig, manual.state, recoveryTick(1_000, 0.52));
  assert.equal(stillPaused.decision.action, 'PAUSE', 're-entry requires deliberate resume after takeover');
});

const displayMarket: Market = {
  slug: market.slug, id: market.slug, title: 'Synthetic YES outcome', oppositeTitle: 'Synthetic NO outcome',
  question: 'Synthetic accounting example only', rules: '', gameId: 'synthetic-game', game: 'Synthetic game',
  league: 'MLB', start: new Date(NOW + 60_000).toISOString(), teams: [], kind: 'synthetic',
  bid: 0.38, ask: 0.40, price: 0.40, volume: null, fee: market.feeCoefficient,
  active: true, history: [], signals: [], observedAt: NOW,
};
const ledger = (): Profile => ({
  cash: 10, positions: [], watches: [], equity: [{time: NOW, price: 10}], config: {...DEFAULT_CONFIG},
});

test('synthetic ledger preserves total entry cost and fees across several partial exits', () => {
  const profile = ledger();
  const entryCommand = command({budget: 5});
  const entry = executePaperCommand(entryCommand, account(), market, book(), policy());
  applyPaperExecution(profile, entryCommand, entry, displayMarket, 0.38);
  const original = structuredClone(profile.positions[0]);
  let proceeds = 0;

  for (const [quantity, price] of [[3, 0.38], [4, 0.42], [original.contracts - 7, 0.46]]) {
    const open = profile.positions.find(position => position.status === 'open')!;
    const sellCommand = command({
      action: 'SELL', budget: undefined, quantity, limitPrice: price, positionId: open.id,
    });
    const result = executePaperCommand(sellCommand, account({cash: profile.cash, availableQuantity: open.contracts}),
      market, book(price, Number((price + 0.02).toFixed(2))), policy());
    assert.equal(result.filledQty, quantity);
    proceeds += result.cashDelta;
    applyPaperExecution(profile, sellCommand, result, displayMarket, price);
    close(profile.positions.reduce((sum, position) => sum + position.amount, 0), original.amount);
    close(profile.positions.reduce((sum, position) => sum + position.fee, 0), original.fee);
    close(profile.positions.reduce((sum, position) => sum + position.contracts, 0), original.contracts);
    close(profile.cash, 10 - original.amount + proceeds);
  }
  assert.equal(profile.positions.filter(position => position.status === 'open').length, 0);
  close(profile.positions.reduce((sum, position) => sum + (position.payout ?? 0) - position.amount, 0), profile.cash - 10);

  const beforeReplay = JSON.stringify(profile);
  applyPaperExecution(profile, entryCommand, {...entry, replayed: true, apply: false, cashDelta: 0}, displayMarket, 0.38);
  assert.equal(JSON.stringify(profile), beforeReplay, 'journal replay cannot mint another lot or cash change');
});

test('synthetic near-full fractional exit retains every unsold micro-contract', () => {
  const profile = ledger();
  profile.positions.push({
    id: '00000000-0000-4000-8000-111111111111', slug: market.slug, game: displayMarket.game,
    title: displayMarket.title, league: 'MLB', side: 'YES', entry: 0.40, entryProbability: 0.40,
    amount: 0.8, contracts: 2, fee: 0, coefficient: 0, time: NOW, signal: 'MANUAL', reason: 'Synthetic', status: 'open',
  });
  const sell = command({action: 'SELL', budget: undefined, quantity: 1.999999, limitPrice: 0.40,
    positionId: profile.positions[0].id});
  const result = executePaperCommand(sell, account({availableQuantity: 2}),
    {...market, minimumTradeQty: 0.000001, quantityIncrement: 0.000001, feeCoefficient: 0}, book(0.40, 0.42), policy());
  assert.equal(result.filledQty, 1.999999);
  applyPaperExecution(profile, sell, result, {...displayMarket, fee: 0}, 0.40);
  const open = profile.positions.filter(position => position.status === 'open');
  assert.equal(open.length, 1, 'a relative ratio tolerance must not close unsold quantity');
  assert.equal(open[0].contracts, 0.000001);
});

test('manual takeover survives a no-fill exit and applies only to the selected strategy market', () => {
  const profile = ledger();
  profile.trading = {settings: {entryPresets: [5, 10, 25], exitPresets: [25, 50, 100], maxPriceDrift: 0.02},
    automation: {
      id: 'synthetic-session', mode: 'paper', status: 'running', slug: market.slug, side: 'YES',
      config: strategyConfig, state: initialDipReversionState(strategyConfig), startedAt: NOW,
      lastStepAt: NOW, lastReason: '', manualTakeover: false, observations: 0, orders: 0,
      budgetLimit: 10, spent: 0,
    }};
  takeManualControl(profile, 'different-synthetic-market');
  assert.equal(profile.trading.automation!.status, 'running');
  takeManualControl(profile, market.slug);
  const exit = command({action: 'SELL', budget: undefined, quantity: 1, limitPrice: 0.40});
  const noFill = executePaperCommand(exit, account({availableQuantity: 1}), market, book(), policy());
  assert.equal(noFill.filledQty, 0);
  applyPaperExecution(profile, exit, noFill, displayMarket, 0.38);
  const persisted = JSON.parse(JSON.stringify(profile)) as Profile;
  assert.equal(persisted.trading!.automation!.status, 'paused');
  assert.equal(persisted.trading!.automation!.manualTakeover, true);
  assert.equal(persisted.trading!.automation!.state.phase, 'PAUSED');
  assert.equal(persisted.cash, 10);
});

// D1 batch transactions are SQLite transactions. Exercise the actual checked-in
// commit SQL, with real migrations, while making no claim about a hosted D1 run.
function journalFixture() {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0000_black_the_santerians.sql', '0001_silky_hammerhead.sql', '0002_huge_aqueduct.sql']) {
    database.exec(readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
  }
  const source = readFileSync(new URL('../lib/server/trading.ts', import.meta.url), 'utf8');
  const insert = source.match(/'(INSERT INTO trading_commands[^']+)'/)?.[1];
  const update = source.match(/'(UPDATE profiles SET value=\?,version=version\+1[^']+)'/)?.[1];
  assert.ok(insert && update, 'journal transaction SQL must remain inspectable');
  database.prepare('INSERT INTO profiles(id,value,version) VALUES(?,?,?)').run('synthetic-user', '{"cash":10}', 0);
  const commit = (id: string, expectedVersion: number, cash: number) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const inserted = database.prepare(insert).run(id, 'synthetic-user', id, 'synthetic-fingerprint', '{"status":"filled"}', NOW,
        'synthetic-user', expectedVersion);
      const changed = database.prepare(update).run(JSON.stringify({cash}), 'synthetic-user', expectedVersion, id);
      database.exec('COMMIT');
      return {inserted: Number(inserted.changes), changed: Number(changed.changes)};
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  return {database, commit};
}

test('actual journal SQL rejects a raced stale profile without storing an orphan fill', () => {
  const {database, commit} = journalFixture();
  try {
    assert.deepEqual(commit('synthetic-first', 0, 5), {inserted: 1, changed: 1});
    assert.deepEqual(commit('synthetic-raced', 0, 1), {inserted: 0, changed: 0});
    const row = database.prepare('SELECT value,version FROM profiles WHERE id=?').get('synthetic-user');
    assert.equal(row?.value, '{"cash":5}');
    assert.equal(row?.version, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM trading_commands').get()?.count, 1);
  } finally {database.close();}
});

test('actual journal SQL rolls back duplicate command insertion and keeps ledger cash unchanged', () => {
  const {database, commit} = journalFixture();
  try {
    commit('synthetic-duplicate', 0, 5);
    assert.throws(() => commit('synthetic-duplicate', 1, 0), /UNIQUE constraint/);
    const row = database.prepare('SELECT value,version FROM profiles WHERE id=?').get('synthetic-user');
    assert.equal(row?.value, '{"cash":5}');
    assert.equal(row?.version, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM trading_commands').get()?.count, 1);
  } finally {database.close();}
});

test('actual journal SQL rolls its fill record back when the ledger write fails', () => {
  const {database, commit} = journalFixture();
  try {
    database.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE ON profiles BEGIN SELECT RAISE(ABORT, 'Synthetic write failure'); END");
    assert.throws(() => commit('synthetic-failed-write', 0, 5), /Synthetic write failure/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM trading_commands').get()?.count, 0);
    const row = database.prepare('SELECT value,version FROM profiles WHERE id=?').get('synthetic-user');
    assert.equal(row?.value, '{"cash":10}');
    assert.equal(row?.version, 0);
  } finally {database.close();}
});
