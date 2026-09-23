import type { CreateOrderParams, CreateOrderResponse, OrderIntent } from 'polymarket-us';

/**
 * Server-side foundation only: nothing instantiates an SDK or enables trading here.
 * Verified 2026-09-23 against /api-reference/orders/overview and the official
 * polymarket-us 0.1.1 declarations. No provider idempotency field is documented.
 * Crucially, the wire price is ALWAYS YES/long price, including SHORT intents.
 */
export type LiveOrderCommand = {
  commandId: string;
  accountId: string;
  marketSlug: string;
  side: 'YES' | 'NO';
  action: 'BUY' | 'SELL';
  source: 'MANUAL' | 'AUTOMATIC';
  quantity: number;
  /** Selected outcome price: maximum for BUY, minimum for SELL. */
  limitPrice: number;
  /** BUY cash ceiling including fees, supplied by the user's preset/strategy. */
  budgetUsd?: number;
  createdAt: number;
};

export type LiveReadiness = {
  /** All values must come from trusted server configuration/state, never request JSON. */
  configuredAccountId: string | null;
  credentialsConfigured: boolean;
  /** Remains false until authenticated fixtures verify this SDK and market contract. */
  authenticatedContractValidated: boolean;
  liveArmed: boolean;
  automationArmed: boolean;
  marketSlug: string;
  league: 'mlb' | 'nfl';
  marketOpen: boolean;
  minimumTradeQty: number;
  orderPriceMinTickSize: number;
  feeCoefficient: number;
  marketStreamConnected: boolean;
  privateStreamConnected: boolean;
  lastMarketHeartbeatAt: number;
  lastPrivateHeartbeatAt: number;
  /** Includes a valid initial book and no gap since; price need not change to be live. */
  bookSynchronized: boolean;
  connectionEpoch: string;
  reconciledConnectionEpoch: string | null;
  accountReconciled: boolean;
  /** Includes in-flight orders and command journal entries with an unknown outcome. */
  hasUnresolvedCommand: boolean;
  /** Confirm cancels/fills first. A cancel acknowledgment does not free inventory. */
  conflictingOrdersReconciled: boolean;
  /** Manual exit requires durable bot pause to prevent immediate automatic re-entry. */
  manualExitReentryPaused: boolean;
  availableCashUsd: number;
  /** Available to sell for this exact account, market and selected outcome. */
  availableQuantity: number;
  marketExposureUsd: number;
  totalExposureUsd: number;
  limits: {
    maxOrderDebitUsd: number;
    maxOrderQuantity: number;
    maxMarketExposureUsd: number;
    maxTotalExposureUsd: number;
    maxCommandAgeMs: number;
    maxStreamAgeMs: number;
  };
};

export type LiveCommandRecord = {
  commandId: string;
  accountId: string;
  marketSlug: string;
  fingerprint: string;
  state: 'submitting' | 'pending' | 'unknown' | 'blocked';
  reason: string;
  createdAt: number;
  updatedAt: number;
  orderId?: string;
  request?: CreateOrderParams;
};

export interface LiveCommandJournal {
  /**
   * Durable, atomic INSERT-if-absent keyed by (accountId, commandId). Existing
   * records MUST survive restarts; do not expire unresolved entries. This claim
   * commits before any network operation. A crash after claim requires reconcile.
   */
  claim(record: LiveCommandRecord): Promise<{ claimed: boolean; record: LiveCommandRecord }>;
  /** Durable update under the account coordinator; never overwrite another command. */
  save(record: LiveCommandRecord): Promise<void>;
}

export type LiveSubmission = {
  record: LiveCommandRecord;
  replayed: boolean;
  /** This adapter NEVER treats an HTTP acknowledgment as a fill. */
  requiresReconciliation: boolean;
};

export interface LiveAdapterDependencies {
  journal: LiveCommandJournal;
  /** Must issue exactly one SDK create call, with transport retries disabled. */
  transport: { create(request: CreateOrderParams): Promise<Pick<CreateOrderResponse, 'id'>> };
  /**
   * Durable account-wide coordinator, including risk reservations across markets.
   * A process-local mutex is insufficient when multiple instances can submit.
   * After every pending/unknown submission, reserve cash/quantity until official
   * fills/cancels and balances/positions have been reconciled atomically.
   */
  runExclusive<T>(accountId: string, task: () => Promise<T>): Promise<T>;
  /** Read after the journal claim; exclude this command from hasUnresolvedCommand. */
  readServerState(command: LiveOrderCommand): Promise<LiveReadiness>;
  now?: () => number;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const aligned = (value: number, step: number) =>
  positive(step) && Math.abs(value / step - Math.round(value / step)) < 1e-8;

function fingerprint(command: LiveOrderCommand): string {
  return JSON.stringify([
    command.accountId, command.marketSlug, command.side, command.action,
    command.source, command.quantity, command.limitPrice, command.budgetUsd ?? null,
    command.createdAt,
  ]);
}

function commandProblem(command: LiveOrderCommand): string | null {
  if (![command.commandId, command.accountId, command.marketSlug].every(
    value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256,
  )) return 'INVALID_IDENTIFIER';
  if (!['YES', 'NO'].includes(command.side) || !['BUY', 'SELL'].includes(command.action)
      || !['MANUAL', 'AUTOMATIC'].includes(command.source)) return 'INVALID_ORDER_DIRECTION';
  if (!positive(command.quantity) || !Number.isSafeInteger(Math.ceil(command.quantity)))
    return 'INVALID_QUANTITY';
  if (!Number.isFinite(command.limitPrice) || command.limitPrice < 0.01 || command.limitPrice > 0.99)
    return 'INVALID_LIMIT';
  if (!aligned(command.limitPrice, 0.00000001)) return 'UNSUPPORTED_PRICE_PRECISION';
  if (!Number.isFinite(command.createdAt)) return 'INVALID_TIMESTAMP';
  if (command.action === 'BUY' && !positive(command.budgetUsd ?? NaN)) return 'INVALID_BUDGET';
  return null;
}

/** Pure translation only; call submit() for server readiness and risk enforcement. */
export function toUSLimitOrder(command: LiveOrderCommand): CreateOrderParams {
  const problem = commandProblem(command);
  if (problem) throw new Error(problem);
  const intents: Record<LiveOrderCommand['action'], Record<LiveOrderCommand['side'], OrderIntent>> = {
    BUY: { YES: 'ORDER_INTENT_BUY_LONG', NO: 'ORDER_INTENT_BUY_SHORT' },
    SELL: { YES: 'ORDER_INTENT_SELL_LONG', NO: 'ORDER_INTENT_SELL_SHORT' },
  };
  // Decimal string prevents the ordinary 1 - .83 floating-point artifact on wire.
  const yesPrice = command.side === 'YES' ? command.limitPrice : 1 - command.limitPrice;
  return {
    marketSlug: command.marketSlug,
    intent: intents[command.action][command.side],
    type: 'ORDER_TYPE_LIMIT',
    price: { value: Number(yesPrice.toFixed(8)).toString(), currency: 'USD' },
    quantity: command.quantity,
    tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
    manualOrderIndicator: command.source === 'MANUAL'
      ? 'MANUAL_ORDER_INDICATOR_MANUAL' : 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    participateDontInitiate: false,
    synchronousExecution: false,
  };
}

function readinessProblem(command: LiveOrderCommand, state: LiveReadiness, now: number): string | null {
  if (!state.credentialsConfigured || !state.configuredAccountId) return 'ACCOUNT_NOT_CONFIGURED';
  if (state.configuredAccountId !== command.accountId) return 'ACCOUNT_MISMATCH';
  if (!state.authenticatedContractValidated) return 'AUTHENTICATED_CONTRACT_NOT_VALIDATED';
  if (!state.liveArmed) return 'LIVE_NOT_ARMED';
  if (command.source === 'AUTOMATIC' && !state.automationArmed) return 'AUTOMATION_NOT_ARMED';
  if (state.marketSlug !== command.marketSlug || !['mlb', 'nfl'].includes(state.league))
    return 'MARKET_OUT_OF_SCOPE';
  if (!state.marketOpen) return 'MARKET_CLOSED';
  if (!Object.values(state.limits).every(positive)) return 'INVALID_LIMIT_CONFIGURATION';
  if (!positive(state.minimumTradeQty) || !positive(state.orderPriceMinTickSize)
      || !nonnegative(state.feeCoefficient)) return 'INVALID_MARKET_RULES';
  if (!Number.isFinite(now) || command.createdAt > now
      || now - command.createdAt > state.limits.maxCommandAgeMs) return 'COMMAND_EXPIRED';
  if (!state.marketStreamConnected || !state.privateStreamConnected || !state.bookSynchronized)
    return 'STREAM_NOT_READY';
  if (![state.lastMarketHeartbeatAt, state.lastPrivateHeartbeatAt].every(
    at => Number.isFinite(at) && at <= now && now - at <= state.limits.maxStreamAgeMs,
  )) return 'STREAM_STALE';
  if (!state.accountReconciled || !state.connectionEpoch
      || state.connectionEpoch !== state.reconciledConnectionEpoch) return 'ACCOUNT_NOT_RECONCILED';
  if (state.hasUnresolvedCommand) return 'UNRESOLVED_COMMAND';
  if (!state.conflictingOrdersReconciled) return 'CONFLICTING_ORDERS';
  if (![state.availableCashUsd, state.availableQuantity, state.marketExposureUsd,
    state.totalExposureUsd].every(nonnegative)) return 'INVALID_ACCOUNT_STATE';
  if (!aligned(command.quantity, state.minimumTradeQty)
      || command.quantity < state.minimumTradeQty) return 'QUANTITY_OFF_INCREMENT';
  const wirePrice = command.side === 'YES' ? command.limitPrice : 1 - command.limitPrice;
  if (!aligned(wirePrice, state.orderPriceMinTickSize)) return 'PRICE_OFF_INCREMENT';
  if (command.quantity > state.limits.maxOrderQuantity) return 'ORDER_QUANTITY_LIMIT';
  if (command.action === 'SELL') {
    if (command.quantity > state.availableQuantity) return 'INSUFFICIENT_POSITION';
    if (command.source === 'MANUAL' && !state.manualExitReentryPaused)
      return 'PAUSE_REENTRY_BEFORE_MANUAL_EXIT';
    return null;
  }
  // Conservative BUY reservation, NOT a fee quote: p*(1-p) <= .25. Add one
  // cent per possible minimum-quantity fill for rounding. This may deliberately
  // underuse a preset; sizing/preview can be refined only after contract validation.
  const maxFills = Math.ceil(command.quantity / state.minimumTradeQty);
  const grossCents = Math.ceil(command.quantity * command.limitPrice * 100);
  const feeCents = Math.ceil(state.feeCoefficient * command.quantity * 0.25 * 100)
    + (state.feeCoefficient > 0 ? maxFills : 0);
  const debitCents = grossCents + feeCents;
  const availableCents = (value: number) => Math.floor(value * 100);
  if (!Number.isSafeInteger(debitCents)) return 'INVALID_DEBIT';
  if (debitCents > availableCents(command.budgetUsd!)) return 'BUDGET_EXCEEDED';
  if (debitCents > availableCents(state.limits.maxOrderDebitUsd)) return 'ORDER_DEBIT_LIMIT';
  if (debitCents > availableCents(state.availableCashUsd)) return 'INSUFFICIENT_CASH';
  if (debitCents > availableCents(state.limits.maxMarketExposureUsd - state.marketExposureUsd))
    return 'MARKET_EXPOSURE_LIMIT';
  if (debitCents > availableCents(state.limits.maxTotalExposureUsd - state.totalExposureUsd))
    return 'ACCOUNT_EXPOSURE_LIMIT';
  return null;
}

export function createLiveExecutionAdapter(dependencies: LiveAdapterDependencies) {
  const now = dependencies.now ?? Date.now;
  return {
    async submit(command: LiveOrderCommand): Promise<LiveSubmission> {
      if (typeof window !== 'undefined') throw new Error('SERVER_ONLY');
      const invalid = commandProblem(command);
      if (invalid) throw new Error(invalid);
      // Copy before any await, preventing a caller from changing a claimed command.
      const input = Object.freeze({ ...command });
      return dependencies.runExclusive(input.accountId, async () => {
        const proposed: LiveCommandRecord = {
          commandId: input.commandId, accountId: input.accountId, marketSlug: input.marketSlug,
          fingerprint: fingerprint(input), state: 'submitting', reason: 'AWAITING_VALIDATION',
          createdAt: input.createdAt, updatedAt: now(),
        };
        const claim = await dependencies.journal.claim(proposed);
        if (!claim.claimed) {
          if (claim.record.fingerprint !== proposed.fingerprint)
            throw new Error('COMMAND_ID_CONFLICT');
          return { record: claim.record, replayed: true,
            requiresReconciliation: claim.record.state !== 'blocked' };
        }
        let state: LiveReadiness;
        try {
          state = await dependencies.readServerState(input);
        } catch {
          const blocked = { ...proposed, state: 'blocked' as const,
            reason: 'SERVER_STATE_UNAVAILABLE', updatedAt: now() };
          await dependencies.journal.save(blocked);
          return { record: blocked, replayed: false, requiresReconciliation: false };
        }
        const problem = readinessProblem(input, state, now());
        if (problem) {
          const blocked = { ...proposed, state: 'blocked' as const, reason: problem, updatedAt: now() };
          await dependencies.journal.save(blocked);
          return { record: blocked, replayed: false, requiresReconciliation: false };
        }
        const request = toUSLimitOrder(input);
        const sending = { ...proposed, request, reason: 'SUBMISSION_STARTED', updatedAt: now() };
        // Do not send unless the exact request is durably recorded first.
        await dependencies.journal.save(sending);
        // Persistence may take long enough for a disconnect, disarm, expired click
        // or new fill to invalidate the original check. Re-read under the same lock.
        let finalProblem: string | null;
        try {
          finalProblem = readinessProblem(input, await dependencies.readServerState(input), now());
        } catch {
          finalProblem = 'SERVER_STATE_UNAVAILABLE';
        }
        if (finalProblem) {
          const blocked = { ...sending, state: 'blocked' as const,
            reason: finalProblem, updatedAt: now() };
          await dependencies.journal.save(blocked);
          return { record: blocked, replayed: false, requiresReconciliation: false };
        }
        let result: LiveCommandRecord;
        try {
          const acknowledgment = await dependencies.transport.create(request);
          if (typeof acknowledgment?.id !== 'string' || !acknowledgment.id.trim())
            throw new Error('INVALID_ACKNOWLEDGMENT');
          result = { ...sending, state: 'pending', orderId: acknowledgment.id,
            reason: 'AWAITING_OFFICIAL_RECONCILIATION', updatedAt: now() };
        } catch {
          // Timeout, disconnect, malformed response, or opaque error can follow an
          // accepted order. Never retry, fall back to a market order, or free risk.
          result = { ...sending, state: 'unknown', reason: 'SUBMISSION_OUTCOME_UNKNOWN', updatedAt: now() };
        }
        try {
          await dependencies.journal.save(result);
        } catch {
          // The durable submitting record remains unresolved and prevents resend.
          result = { ...result, state: 'unknown', reason: 'JOURNAL_WRITE_FAILED' };
        }
        return { record: result, replayed: false, requiresReconciliation: true };
      });
    },
  };
}

/*
 * Not implemented here: credential/account setup, authenticated fixture checks,
 * durable journal/coordinator storage, cancel reconciliation, fill accounting or
 * automation resume. Consumers must dedupe official execution IDs and atomically
 * update positions/balances before clearing pending/unknown risk. Cancel/pause
 * never means close. New automation arming requires an explicit fresh decision.
 */
