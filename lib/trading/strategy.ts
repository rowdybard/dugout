import { executePaperCommand, executionDataIssue } from './execution.ts';
import { fromUnits, roundPriceToIncrement, toUnits } from './money.ts';
import type { DipReversionConfig, DipReversionInput, DipReversionState, PaperExecution, StrategyEvaluation } from './types';

/** Test assumptions only: these values have not been optimized or shown profitable. */
export const DEFAULT_DIP_CONFIG: DipReversionConfig = {
  id: 'DIP_REVERSION',
  version: 'dip-reversion-v1',
  baselineWindowMs: 5 * 60_000,
  minimumHistoryMs: 2 * 60_000,
  minSamples: 12,
  declinePoints: 5,
  recoveryPoints: 1.5,
  recoveryConfirmations: 2,
  maxSpreadPoints: 3,
  minimumDepth: 10,
  entryBudget: 5,
  limitOffsetPoints: 1,
  targetReturn: 0.08,
  stopReturn: 0.06,
  maxHoldMs: 10 * 60_000,
  cooldownMs: 5 * 60_000,
  signalExpiryMs: 3 * 60_000,
  allowedGamePhases: ['PREGAME'],
};

export const DEFAULT_DIP_REVERSION = DEFAULT_DIP_CONFIG;

export function initialDipState(config: DipReversionConfig = DEFAULT_DIP_CONFIG): DipReversionState {
  return { version: config.version, phase: 'WAITING' };
}

export const initialDipReversionState = initialDipState;

export function validConfig(config: DipReversionConfig): boolean {
  const positive = [config.baselineWindowMs, config.minimumHistoryMs, config.minSamples, config.declinePoints,
    config.recoveryPoints, config.recoveryConfirmations, config.maxSpreadPoints, config.minimumDepth,
    config.entryBudget, config.targetReturn, config.stopReturn, config.maxHoldMs, config.signalExpiryMs];
  return config.id === 'DIP_REVERSION' && !!config.version &&
    positive.every(value => Number.isFinite(value) && value > 0) &&
    Number.isInteger(config.minSamples) && config.minSamples >= 3 && Number.isInteger(config.recoveryConfirmations) &&
    config.recoveryPoints < config.declinePoints && config.minimumHistoryMs <= config.baselineWindowMs &&
    Number.isFinite(config.cooldownMs) && config.cooldownMs >= 0 &&
    Number.isFinite(config.limitOffsetPoints) && config.limitOffsetPoints >= 0 && config.limitOffsetPoints < 100 &&
    config.stopReturn < 1 && Array.isArray(config.allowedGamePhases) && config.allowedGamePhases.length > 0 &&
    config.allowedGamePhases.every(phase => phase === 'PREGAME' || phase === 'IN_PLAY');
}

function sideQuotes(input: DipReversionInput) {
  const bids = (input.side === 'YES' ? input.book.bids : input.book.asks)
    .map(level => ({ price: input.side === 'YES' ? level.price : fromUnits(toUnits(1) - toUnits(level.price)), quantity: level.quantity }))
    .filter(level => level.quantity > 0).sort((a, b) => b.price - a.price);
  const asks = (input.side === 'YES' ? input.book.asks : input.book.bids)
    .map(level => ({ price: input.side === 'YES' ? level.price : fromUnits(toUnits(1) - toUnits(level.price)), quantity: level.quantity }))
    .filter(level => level.quantity > 0).sort((a, b) => a.price - b.price);
  return { bids, asks, bid: bids[0]?.price, ask: asks[0]?.price };
}

/**
 * Event-time candidate evaluation, never a profitability assertion. A falling
 * line only arms a dip; independent, later recovery observations are required.
 * Pending signals cannot be emitted again until their actual fill is recorded.
 */
export function evaluateDipReversion(config: DipReversionConfig, previous: DipReversionState, input: DipReversionInput): StrategyEvaluation {
  let state: DipReversionState = { ...previous };
  const answer = (action: StrategyEvaluation['decision']['action'], reason: string, extra: Partial<StrategyEvaluation['decision']> = {}): StrategyEvaluation => ({
    state: { ...state, reason },
    decision: { strategy: 'DIP_REVERSION', version: config.version, action, reason, at: input.now, ...extra },
  });
  const pause = (reason: string) => {
    state = { ...state, phase: 'PAUSED' };
    return answer('PAUSE', reason);
  };
  if (!validConfig(config)) return pause('Strategy configuration is invalid.');
  if (input.now !== input.policy.now) return pause('Strategy and execution clocks disagree.');
  if (previous.version !== config.version) {
    if (input.position && input.position.quantity > 0) return pause('A strategy version changed while a position is open. Reconcile its ownership first.');
    state = initialDipState(config);
  }
  if (input.policy.manualTakeover) return pause('Manual control paused this market. Resume explicitly before automated re-entry.');
  if (input.policy.automation !== 'PAPER') return pause('Paper automation is off.');
  const dataIssue = executionDataIssue(input.policy);
  if (dataIssue) return pause(dataIssue);
  if (!input.market.active || input.book.state !== 'MARKET_STATE_OPEN') return pause('Market is not open.');
  if (input.market.league !== 'MLB' && input.market.league !== 'NFL') return pause('Only MLB and NFL are supported.');
  if (input.side !== 'YES' && input.side !== 'NO') return pause('Choose a valid outcome.');
  if (state.phase === 'PAUSED') return answer('PAUSE', 'Strategy is paused. Resume explicitly.');
  if (state.phase === 'PENDING') return answer('WAIT', 'Waiting for the previous order result.');

  try {
    const quotes = sideQuotes(input);
    const position = input.position;
    const bid = quotes.bid;
    const ask = quotes.ask;
    if (bid === undefined || bid <= 0 || bid >= 1 || (ask !== undefined && (ask <= 0 || ask >= 1 || bid > ask))) return answer('WAIT', 'Waiting for a valid executable buyer quote.');
    if ((!position || position.quantity <= 0) && ask === undefined) return answer('WAIT', 'Waiting for a valid two-sided market.');
    const tick = input.market.priceIncrement;
    const limit = (action: 'BUY' | 'SELL') => action === 'BUY'
      ? Math.min(roundPriceToIncrement(1 - tick, tick, 'DOWN'), roundPriceToIncrement((ask ?? 1) + config.limitOffsetPoints / 100, tick, 'UP'))
      : Math.max(tick, roundPriceToIncrement(bid - config.limitOffsetPoints / 100, tick, 'DOWN'));
    if (position && position.quantity > 0) {
      if (!Number.isFinite(position.openedAt) || position.openedAt > input.now || !Number.isFinite(position.costBasis) || position.costBasis <= 0) return pause('Position cost or timestamp must be reconciled.');
      state.phase = 'HOLDING';
      const price = limit('SELL');
      const estimate = executePaperCommand({
        commandId: `estimate:${config.version}:${input.now}`, marketSlug: input.market.slug,
        side: input.side, action: 'SELL', source: 'AUTOMATIC', quantity: position.quantity,
        limitPrice: price, createdAt: input.now, strategyVersion: config.version,
      }, input.account, input.market, input.book, input.policy);
      if (estimate.filledQty <= 0) return answer('WAIT', `Exit currently unavailable: ${estimate.reason}`);
      // A partial book can exit part of a position. Attribute only that part's
      // entry cost; do not compare partial proceeds with the entire entry cost.
      const allocatedCost = position.costBasis * estimate.filledQty / position.quantity;
      const netReturn = estimate.cashDelta / allocatedCost - 1;
      const exitReason = netReturn >= config.targetReturn ? 'TARGET'
        : netReturn <= -config.stopReturn ? 'STOP'
          : input.now - position.openedAt >= config.maxHoldMs ? 'TIME' : undefined;
      if (!exitReason) return answer('WAIT', 'Holding; no net target, stop or time exit is triggered.', { estimatedNetReturn: netReturn });
      state = { ...state, phase: 'PENDING', pendingAction: 'SELL' };
      return answer('SELL', exitReason === 'TARGET' ? 'Estimated proceeds after exit fees reached the net target.'
        : exitReason === 'STOP' ? 'Estimated proceeds reached the configured loss exit.' : 'Maximum holding time reached.', {
        quantity: position.quantity, limitPrice: price, exitReason, estimatedNetReturn: netReturn,
      });
    }

    if (state.phase === 'HOLDING') return pause('Expected a held position but none was supplied. Reconcile before re-entry.');
    if (!config.allowedGamePhases.includes(input.gamePhase)) return answer('WAIT', 'This strategy does not enter during the current game phase.');
    if (state.cooldownUntil && input.now < state.cooldownUntil) {
      state.phase = 'COOLDOWN';
      return answer('WAIT', 'Waiting for the configured cooldown.');
    }
    if (state.phase === 'COOLDOWN') state = initialDipState(config);

    // Strict <= now is essential: appending a favorable future record must not
    // change an earlier decision. Deduplicate timestamps; no candle interpolation.
    const byTime = new Map<number, number>();
    for (const point of input.history) {
      if (Number.isFinite(point.time) && point.time <= input.now && point.time >= input.now - config.baselineWindowMs && Number.isFinite(point.price) && point.price > 0 && point.price < 1) {
        byTime.set(point.time, input.side === 'YES' ? point.price : fromUnits(toUnits(1) - toUnits(point.price)));
      }
    }
    const observations = [...byTime].sort((a, b) => a[0] - b[0]);
    const latest = observations.at(-1);
    if (!latest || input.now - latest[0] > input.policy.maxBookAgeMs) return answer('WAIT', 'Waiting for a fresh strategy observation.');
    if (state.lastObservedAt !== undefined && latest[0] <= state.lastObservedAt) return answer('WAIT', 'Waiting for a new observation; repeated snapshots do not add confirmations.');
    const [time, price] = latest;
    const priorPrice = state.lastObservedPrice;
    state.lastObservedAt = time;
    state.lastObservedPrice = price;

    if (state.phase === 'WAITING') {
      if (observations.length < config.minSamples || time - observations[0][0] < config.minimumHistoryMs) return answer('WAIT', 'Collecting enough history for a market-specific baseline.');
      const values = observations.slice(0, -1).map(([, value]) => value).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      const baseline = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      if (baseline - price < config.declinePoints / 100 - 1e-9) return answer('WAIT', 'No qualifying decline from this market’s rolling median.');
      state = { ...state, phase: 'DIP', baseline, trough: price, dipAt: time, recoveryCount: 0 };
      return answer('WAIT', 'Decline detected. Waiting for later recovery confirmation.');
    }

    if (state.phase !== 'DIP' || state.trough === undefined || state.baseline === undefined || state.dipAt === undefined) return pause('Strategy state is incomplete.');
    if (time - state.dipAt > config.signalExpiryMs || price >= state.baseline) {
      state = { ...initialDipState(config), lastObservedAt: time, lastObservedPrice: price };
      return answer('WAIT', 'The dip setup expired or fully recovered before entry.');
    }
    if (price < state.trough) {
      state.trough = price;
      state.recoveryCount = 0;
      return answer('WAIT', 'Price is still falling. No entry.');
    }
    if (price - state.trough < config.recoveryPoints / 100 - 1e-9 || (priorPrice !== undefined && price < priorPrice)) {
      state.recoveryCount = 0;
      return answer('WAIT', 'Recovery is not yet sustained.');
    }
    state.recoveryCount = (state.recoveryCount ?? 0) + 1;
    if (state.recoveryCount < config.recoveryConfirmations) return answer('WAIT', 'Waiting for another independent recovery observation.');
    if (ask === undefined || (ask - bid) * 100 > config.maxSpreadPoints + 1e-9) return answer('WAIT', 'Spread exceeds the strategy entry limit.');
    const priceLimit = limit('BUY');
    const availableDepth = quotes.asks.filter(level => level.price <= priceLimit).reduce((sum, level) => sum + level.quantity, 0);
    if (availableDepth < config.minimumDepth) return answer('WAIT', 'Too little size is available within the entry price limit.');
    const estimate = executePaperCommand({
      commandId: `estimate:${config.version}:${input.now}`, marketSlug: input.market.slug,
      side: input.side, action: 'BUY', source: 'AUTOMATIC', budget: config.entryBudget,
      limitPrice: priceLimit, createdAt: input.now, strategyVersion: config.version,
    }, input.account, input.market, input.book, input.policy);
    if (estimate.filledQty <= 0) return answer('WAIT', `Entry gate: ${estimate.reason}`);
    state = { ...state, phase: 'PENDING', pendingAction: 'BUY' };
    return answer('BUY', 'A defined decline and later recovery passed spread, depth and exposure checks. This is a paper test.', { budget: config.entryBudget, limitPrice: priceLimit });
  } catch {
    return pause('Invalid decimal or market input. No strategy action was emitted.');
  }
}

/** Apply only an actually persisted execution; never infer a fill from a signal. */
export function recordStrategyExecution(
  config: DipReversionConfig,
  previous: DipReversionState,
  result: PaperExecution,
  remainingPositionQty: number,
): DipReversionState {
  if (result.replayed) return { ...previous };
  if (result.status === 'unknown') return { ...previous, phase: 'PENDING', reason: result.reason };
  if (previous.phase !== 'PENDING' || !previous.pendingAction) return { ...previous };
  if (previous.pendingAction === 'BUY') {
    return result.apply && result.filledQty > 0
      ? { ...previous, phase: 'HOLDING', pendingAction: undefined, reason: result.reason }
      : { ...initialDipState(config), lastObservedAt: previous.lastObservedAt, lastObservedPrice: previous.lastObservedPrice, reason: result.reason };
  }
  if (!Number.isFinite(remainingPositionQty) || remainingPositionQty < 0) return { ...previous, phase: 'PAUSED', reason: 'Remaining position needs reconciliation.' };
  if (remainingPositionQty > 0) return { ...previous, phase: 'HOLDING', pendingAction: undefined, reason: result.reason };
  return { ...initialDipState(config), phase: 'COOLDOWN', cooldownUntil: result.at + config.cooldownMs, reason: 'Position exited; waiting for cooldown.' };
}
