import test from 'node:test';
import assert from 'node:assert/strict';
import { executePaperCommand } from '../lib/trading/execution.ts';
import { feeUnits, fromUnits, roundHalfEven, toUnits } from '../lib/trading/money.ts';
import { DEFAULT_DIP_CONFIG, evaluateDipReversion, initialDipState, recordStrategyExecution } from '../lib/trading/strategy.ts';
import type { Book } from '../lib/market/types.ts';
import type { DipReversionConfig, DipReversionInput, ExecutionMarket, ExecutionPolicy, PaperAccount, PaperCommand } from '../lib/trading/types.ts';

// Synthetic accounting and strategy cases; never rendered as actual game data.
const now = Date.parse('2026-09-23T16:00:00Z');
const market: ExecutionMarket = { slug: 'synthetic-mlb', league: 'MLB', active: true, minimumTradeQty: 0.01, quantityIncrement: 0.01, priceIncrement: 0.005, feeCoefficient: 0.0695 };
const book: Book = { bids: [{ price: 0.395, quantity: 50 }], asks: [{ price: 0.4, quantity: 50 }], state: 'MARKET_STATE_OPEN', time: new Date(now).toISOString() };
const account: PaperAccount = { cash: 10, marketExposure: 0, totalExposure: 0, availableQuantity: 0 };
const policy: ExecutionPolicy = { now, bookReceivedAt: now, bookSource: 'REST', stateCertain: true, maxBookAgeMs: 15_000, maxCommandAgeMs: 15_000, maxOrderBudget: 10, maxMarketExposure: 20, maxTotalExposure: 100, automation: 'PAPER' };
const buy: PaperCommand = { commandId: 'test-fractional-buy', marketSlug: market.slug, side: 'YES', action: 'BUY', source: 'MANUAL', budget: 10, limitPrice: 0.4, createdAt: now };

test('published half-even ties and fractional cash ceilings are exact', () => {
  assert.equal(roundHalfEven(BigInt(5), BigInt(2)), BigInt(2));
  assert.equal(roundHalfEven(BigInt(7), BigInt(2)), BigInt(4));
  assert.equal(fromUnits(feeUnits(toUnits(2), toUnits(0.5), toUnits(0.05))), 0.02);
  assert.equal(fromUnits(feeUnits(toUnits(2.8), toUnits(0.5), toUnits(0.05))), 0.04);
  const result = executePaperCommand(buy, account, market, book, policy);
  assert.equal(result.status, 'filled');
  assert.equal(result.filledQty, 24);
  assert.equal(result.gross, 9.6);
  assert.equal(result.fees, 0.4);
  assert.equal(result.cashDelta, -10);
  assert.equal(result.unusedBudget, 0);
});

test('allowed fractional sizing differs from whole sizing without exceeding budget', () => {
  const zeroFee = { ...market, feeCoefficient: 0 };
  const command = { ...buy, budget: 1.05 };
  const fractional = executePaperCommand(command, account, zeroFee, book, policy);
  const whole = executePaperCommand(command, account, { ...zeroFee, minimumTradeQty: 1, quantityIncrement: 1 }, book, policy);
  assert.equal(fractional.filledQty, 2.62);
  assert.equal(fractional.unusedBudget, 0.002);
  assert.equal(whole.filledQty, 2);
  assert.equal(whole.unusedBudget, 0.25);
});

test('off-grid sell size, off-grid limit and invalid decimals never mutate money', () => {
  for (const command of [
    { ...buy, limitPrice: 0.403 },
    { ...buy, budget: Number.NaN },
    { ...buy, budget: Number.POSITIVE_INFINITY },
    { ...buy, budget: 0.123456789 },
    { ...buy, source: 'AUTOMATIC' as const },
    { ...buy, createdAt: now + 1 },
  ]) {
    const result = executePaperCommand(command, account, market, book, policy);
    assert.equal(result.status, 'rejected');
    assert.equal(result.cashDelta, 0);
    assert.equal(result.apply, false);
  }
  const sell = executePaperCommand({ ...buy, action: 'SELL', budget: undefined, quantity: 1.005, limitPrice: 0.395 }, { ...account, availableQuantity: 2 }, market, book, policy);
  assert.equal(sell.status, 'rejected');
});

test('crossed snapshots and exposure caps reject entries but caps cannot prevent a manual reduction', () => {
  const crossed = { ...book, bids: [{ price: 0.45, quantity: 10 }] };
  assert.equal(executePaperCommand(buy, account, market, crossed, policy).status, 'rejected');
  assert.equal(executePaperCommand(buy, { ...account, marketExposure: 15, totalExposure: 15 }, market, book, policy).status, 'rejected');
  const exit = executePaperCommand({ ...buy, action: 'SELL', budget: undefined, quantity: 2, limitPrice: 0.395 }, { ...account, availableQuantity: 2, marketExposure: 30, totalExposure: 30 }, market, book, { ...policy, automation: 'OFF' });
  assert.equal(exit.status, 'filled');
  assert.equal(exit.filledQty, 2);
});

const config: DipReversionConfig = { ...DEFAULT_DIP_CONFIG, minSamples: 3, minimumHistoryMs: 20_000, baselineWindowMs: 60_000, declinePoints: 5, recoveryPoints: 1, recoveryConfirmations: 2, minimumDepth: 1, entryBudget: 5 };
function strategyInput(time: number, prices: { time: number; price: number }[], price = prices.at(-1)!.price): DipReversionInput {
  return {
    now: time, market, side: 'YES', account: { ...account }, gamePhase: 'PREGAME',
    policy: { ...policy, now: time, bookReceivedAt: time },
    book: { ...book, bids: [{ price: price - 0.005, quantity: 50 }], asks: [{ price: price + 0.005, quantity: 50 }] },
    history: prices,
  };
}

test('a continuing decline only arms the candidate; later sustained recovery creates one pending entry', () => {
  const history = [{ time: now - 20_000, price: 0.5 }, { time: now - 10_000, price: 0.5 }, { time: now, price: 0.44 }];
  let result = evaluateDipReversion(config, initialDipState(config), strategyInput(now, history));
  assert.equal(result.decision.action, 'WAIT');
  assert.equal(result.state.phase, 'DIP');
  history.push({ time: now + 5_000, price: 0.43 });
  result = evaluateDipReversion(config, result.state, strategyInput(now + 5_000, history));
  assert.equal(result.decision.action, 'WAIT');
  assert.equal(result.state.recoveryCount, 0);
  history.push({ time: now + 10_000, price: 0.44 });
  result = evaluateDipReversion(config, result.state, strategyInput(now + 10_000, history));
  assert.equal(result.decision.action, 'WAIT');
  assert.equal(result.state.recoveryCount, 1);
  const duplicate = evaluateDipReversion(config, result.state, strategyInput(now + 10_000, history));
  assert.equal(duplicate.decision.action, 'WAIT');
  assert.equal(duplicate.state.recoveryCount, 1);
  history.push({ time: now + 15_000, price: 0.445 });
  result = evaluateDipReversion(config, result.state, strategyInput(now + 15_000, history));
  assert.equal(result.decision.action, 'BUY');
  assert.equal(result.state.phase, 'PENDING');
  assert.equal(evaluateDipReversion(config, result.state, strategyInput(now + 15_000, history)).decision.action, 'WAIT');
});

test('pending entry becomes held only after a persisted fill and partial exits retain holdings', () => {
  const pending = { ...initialDipState(config), phase: 'PENDING' as const, pendingAction: 'BUY' as const };
  const result = executePaperCommand(buy, account, market, book, policy);
  const held = recordStrategyExecution(config, pending, result, result.filledQty);
  assert.equal(held.phase, 'HOLDING');
  const failed = recordStrategyExecution(config, pending, { ...result, apply: false, filledQty: 0, status: 'unfilled' }, 0);
  assert.equal(failed.phase, 'WAITING');
  const selling = { ...held, phase: 'PENDING' as const, pendingAction: 'SELL' as const };
  assert.equal(recordStrategyExecution(config, selling, result, 2).phase, 'HOLDING');
  const flat = recordStrategyExecution(config, selling, result, 0);
  assert.equal(flat.phase, 'COOLDOWN');
  assert.equal(flat.cooldownUntil, now + config.cooldownMs);
});

test('net stop exits can use real buyers even with no current sellers', () => {
  const input = strategyInput(now, [{ time: now, price: 0.3 }]);
  input.account.availableQuantity = 10;
  input.position = { quantity: 10, costBasis: 4.17, openedAt: now - 30_000 };
  input.book = { ...book, bids: [{ price: 0.3, quantity: 50 }], asks: [] };
  const result = evaluateDipReversion(config, { ...initialDipState(config), phase: 'HOLDING' }, input);
  assert.equal(result.decision.action, 'SELL');
  assert.equal(result.decision.exitReason, 'STOP');
});
