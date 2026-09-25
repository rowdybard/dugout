import type { Book } from '../market/types';
import type { ExecutionMarket, ExecutionPolicy, PaperAccount, PaperCommand, PaperCommandRecord, PaperExecution, PaperFill } from './types';
import { SCALE, feeNumerator, floorToIncrement, fromUnits, notionalUnits, quantityForBudget, roundedFeeUnits, toUnits } from './money.ts';

const ZERO = BigInt(0);

/** Canonical local command identity; not an undocumented exchange idempotency parameter. */
export function commandFingerprint(command: PaperCommand): string {
  return JSON.stringify([
    command.commandId, command.marketSlug, command.positionId ?? null,
    command.side, command.action, command.source, command.budget ?? null,
    command.quantity ?? null, command.limitPrice, command.createdAt,
    command.strategyVersion ?? null,
  ]);
}

function empty(command: PaperCommand, now: number, reason: string, status: PaperExecution['status'] = 'rejected'): PaperExecution {
  return {
    commandId: command.commandId, fingerprint: commandFingerprint(command), status, reason,
    fills: [], requestedQty: 0, filledQty: 0, remainingQty: 0, gross: 0, fees: 0,
    cashDelta: 0, averagePrice: 0, unusedBudget: Number.isFinite(command.budget) ? command.budget ?? 0 : 0,
    at: now, replayed: false, apply: false, feeModel: 'AGGREGATED_DEPTH_ESTIMATE',
  };
}

/** Fresh authoritative receipt is independent of the last price change in a quiet market. */
export function executionDataIssue(policy: ExecutionPolicy): string | null {
  if (policy.bookSource === 'REPLAY') return 'Replay prices cannot execute a current paper order.';
  if (policy.bookSource !== 'REST' && policy.bookSource !== 'WEBSOCKET') return 'Unrecognized market data source.';
  if (!policy.stateCertain) return 'Waiting for an authoritative market snapshot.';
  if (!Number.isFinite(policy.now) || !Number.isFinite(policy.bookReceivedAt) || !Number.isFinite(policy.maxBookAgeMs) || policy.maxBookAgeMs <= 0) return 'Invalid market data timing.';
  if (policy.bookReceivedAt > policy.now) return 'Market snapshot timestamp is in the future.';
  if (policy.now - policy.bookReceivedAt > policy.maxBookAgeMs) return 'Market snapshot is stale. Refresh before trading.';
  return null;
}

/**
 * Pure immediate-or-cancel PAPER matcher. The caller must atomically persist the
 * ledger and final command record using one account revision/CAS. It must never
 * apply a result twice. A pending/unknown journal entry is a reconciliation gate.
 * No exchange request is sent by this module.
 */
export function executePaperCommand(
  command: PaperCommand,
  account: PaperAccount,
  market: ExecutionMarket,
  book: Book,
  policy: ExecutionPolicy,
  prior?: PaperCommandRecord,
): PaperExecution {
  const reject = (reason: string) => empty(command, policy.now, reason);
  const fingerprint = commandFingerprint(command);
  if (prior) {
    if (prior.commandId !== command.commandId || prior.fingerprint !== fingerprint) return reject('Command ID was already used for different instructions.');
    if (prior.state === 'final' && prior.result) {
      return { ...prior.result, fills: prior.result.fills.map(fill => ({ ...fill })), cashDelta: 0, apply: false, replayed: true };
    }
    return { ...empty(command, policy.now, 'Previous submission needs reconciliation; do not submit it again.', 'unknown'), replayed: true };
  }
  if (!command.commandId || typeof command.commandId !== 'string' || command.commandId.length > 128) return reject('A valid command ID is required.');
  if (command.marketSlug !== market.slug || !market.slug) return reject('Command market does not match the loaded market.');
  if (market.league !== 'MLB' && market.league !== 'NFL') return reject('Only MLB and NFL are supported.');
  if (command.side !== 'YES' && command.side !== 'NO') return reject('Choose a valid market outcome.');
  if (command.action !== 'BUY' && command.action !== 'SELL') return reject('Choose buy or sell.');
  if (command.source !== 'MANUAL' && command.source !== 'AUTOMATIC') return reject('Order source is invalid.');
  if (!market.active || book.state !== 'MARKET_STATE_OPEN') return reject('This market is not open for trading.');
  const dataIssue = executionDataIssue(policy);
  if (dataIssue) return reject(dataIssue);
  if (!Number.isFinite(command.createdAt) || command.createdAt > policy.now || !Number.isFinite(policy.maxCommandAgeMs) || policy.maxCommandAgeMs <= 0 || policy.now - command.createdAt > policy.maxCommandAgeMs) return reject('Order instructions have expired or have an invalid timestamp.');
  if (command.source === 'AUTOMATIC' && (policy.automation !== 'PAPER' || policy.manualTakeover)) return reject('Paper automation is paused or manual control owns this market.');
  if (command.source === 'AUTOMATIC' && !command.strategyVersion) return reject('Automatic orders need a recorded strategy version.');

  try {
    const limit = toUnits(command.limitPrice);
    const increment = toUnits(market.quantityIncrement);
    const minimum = toUnits(market.minimumTradeQty);
    const tick = toUnits(market.priceIncrement);
    const coefficient = toUnits(market.feeCoefficient);
    if (limit <= ZERO || limit >= SCALE || tick <= ZERO || tick >= SCALE || limit % tick !== ZERO) return reject('Limit price must use the market price increment and lie between 0 and 1.');
    if (minimum <= ZERO || increment <= ZERO || minimum % increment !== ZERO) return reject('Market quantity rules are missing or invalid.');
    if (coefficient < ZERO || coefficient > SCALE) return reject('Invalid taker fee coefficient.');
    const cash = toUnits(account.cash);
    const available = toUnits(account.availableQuantity);
    const marketExposure = toUnits(account.marketExposure);
    const totalExposure = toUnits(account.totalExposure);
    if ([cash, available, marketExposure, totalExposure].some(value => value < ZERO) || marketExposure > totalExposure) return reject('Account state must be reconciled before trading.');
    let requested: bigint;
    let budget = ZERO;
    if (command.action === 'BUY') {
      if (command.quantity !== undefined) return reject('Buy instructions must specify a cash budget, not a second size.');
      budget = toUnits(command.budget ?? 0);
      const orderCap = toUnits(policy.maxOrderBudget);
      const marketCap = toUnits(policy.maxMarketExposure);
      const totalCap = toUnits(policy.maxTotalExposure);
      if (budget <= ZERO || orderCap <= ZERO || marketCap <= ZERO || totalCap <= ZERO) return reject('A positive budget and exposure limits are required.');
      if (budget > cash) return reject('The selected amount exceeds available paper cash.');
      if (budget > orderCap) return reject('The selected amount exceeds the per-order limit.');
      if (marketExposure + budget > marketCap || totalExposure + budget > totalCap) return reject('The selected amount exceeds an exposure limit.');
      requested = quantityForBudget(budget, limit, increment, coefficient);
    } else {
      if (command.budget !== undefined) return reject('Sell instructions must specify quantity, not a cash budget.');
      requested = toUnits(command.quantity ?? 0);
      if (requested <= ZERO || requested % increment !== ZERO) return reject('Exit quantity must match the market quantity increment.');
      if (requested > available) return reject('Exit quantity exceeds the available position.');
    }
    if (requested < minimum) return reject('The selected amount is below the market minimum quantity.');

    // Normalize YES book into the selected outcome; reject malformed/crossed
    // books rather than turning bad input into apparently attractive fills.
    if (!Array.isArray(book.bids) || !Array.isArray(book.asks)) return reject('Market book is unavailable.');
    const normalize = (levels: Book['bids'], complement: boolean) => levels.map(level => {
      const rawPrice = toUnits(level.price);
      const quantity = toUnits(level.quantity);
      if (rawPrice <= ZERO || rawPrice >= SCALE || quantity < ZERO) throw new RangeError('Malformed book level.');
      const price = complement ? SCALE - rawPrice : rawPrice;
      if (price % tick !== ZERO) throw new RangeError('Book price does not match market increment.');
      return { price, quantity };
    }).filter(level => level.quantity > ZERO);
    const bids = normalize(command.side === 'YES' ? book.bids : book.asks, command.side === 'NO').sort((a, b) => a.price > b.price ? -1 : a.price < b.price ? 1 : 0);
    const asks = normalize(command.side === 'YES' ? book.asks : book.bids, command.side === 'NO').sort((a, b) => a.price < b.price ? -1 : a.price > b.price ? 1 : 0);
    if (bids.length && asks.length && bids[0].price > asks[0].price) return reject('Market book is crossed; waiting for a consistent snapshot.');
    const levels = command.action === 'BUY' ? asks : bids;
    let remaining = requested;
    let gross = ZERO;
    let feeExact = ZERO;
    let fees = ZERO;
    const fills: PaperFill[] = [];
    for (const level of levels) {
      if (!remaining || (command.action === 'BUY' ? level.price > limit : level.price < limit)) break;
      const executable = floorToIncrement(level.quantity, increment);
      const quantity = executable < remaining ? executable : remaining;
      if (quantity <= ZERO) continue;
      const fillGross = notionalUnits(quantity, level.price);
      const nextFeeExact = feeExact + feeNumerator(quantity, level.price, coefficient);
      const nextFees = roundedFeeUnits(nextFeeExact);
      if (command.action === 'BUY' && gross + fillGross + nextFees > budget) return reject('Protected size exceeded its cash ceiling; no paper fill was applied.');
      fills.push({ price: fromUnits(level.price), quantity: fromUnits(quantity), gross: fromUnits(fillGross), fee: fromUnits(nextFees - fees) });
      gross += fillGross;
      feeExact = nextFeeExact;
      fees = nextFees;
      remaining -= quantity;
    }
    const filled = requested - remaining;
    const cashDelta = command.action === 'BUY' ? -gross - fees : gross - fees;
    if (cash + cashDelta < ZERO) return reject('Insufficient cash after estimated fees.');
    const status = filled === ZERO ? 'unfilled' : remaining === ZERO ? 'filled' : 'partial';
    return {
      commandId: command.commandId, fingerprint, status,
      reason: status === 'unfilled' ? 'No executable quantity within your limit. IOC canceled.' : status === 'partial' ? 'Available size filled; the remaining IOC quantity was canceled.' : 'Paper IOC filled within the selected price limit.',
      fills, requestedQty: fromUnits(requested), filledQty: fromUnits(filled), remainingQty: fromUnits(remaining),
      gross: fromUnits(gross), fees: fromUnits(fees), cashDelta: fromUnits(cashDelta),
      averagePrice: filled > ZERO ? Number(gross) / Number(filled) : 0,
      unusedBudget: command.action === 'BUY' ? fromUnits(budget + cashDelta) : 0,
      at: policy.now, replayed: false, apply: filled > ZERO, feeModel: 'AGGREGATED_DEPTH_ESTIMATE',
    };
  } catch {
    return reject('Invalid decimal, market rules, account amount, or book level. Nothing was filled.');
  }
}
