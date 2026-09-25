import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLiveExecutionAdapter, toUSLimitOrder,
  type LiveCommandJournal, type LiveCommandRecord, type LiveOrderCommand, type LiveReadiness,
} from '../lib/trading/live-adapter.ts';
import type { CreateOrderParams } from 'polymarket-us';

// All orders and account state below are synthetic. No SDK client or network exists.
const at = 1_000_000;
const command = (changes: Partial<LiveOrderCommand> = {}): LiveOrderCommand => ({
  commandId: 'test-command', accountId: 'test-account', marketSlug: 'synthetic-mlb-market',
  side: 'YES', action: 'BUY', source: 'MANUAL', quantity: 20, limitPrice: 0.4,
  budgetUsd: 10, createdAt: at, ...changes,
});
const readiness = (changes: Partial<LiveReadiness> = {}): LiveReadiness => ({
  configuredAccountId: 'test-account', credentialsConfigured: true,
  authenticatedContractValidated: true, liveArmed: true, automationArmed: false,
  marketSlug: 'synthetic-mlb-market', league: 'mlb', marketOpen: true,
  minimumTradeQty: 1, orderPriceMinTickSize: 0.01, feeCoefficient: 0.0695,
  marketStreamConnected: true, privateStreamConnected: true,
  lastMarketHeartbeatAt: at, lastPrivateHeartbeatAt: at, bookSynchronized: true,
  connectionEpoch: 'connection-1', reconciledConnectionEpoch: 'connection-1',
  accountReconciled: true, hasUnresolvedCommand: false,
  conflictingOrdersReconciled: true, manualExitReentryPaused: true,
  availableCashUsd: 100, availableQuantity: 20, marketExposureUsd: 0, totalExposureUsd: 0,
  limits: { maxOrderDebitUsd: 25, maxOrderQuantity: 100, maxMarketExposureUsd: 30,
    maxTotalExposureUsd: 60, maxCommandAgeMs: 2_000, maxStreamAgeMs: 5_000 },
  ...changes,
});

function harness(state = readiness(), failTransport = false) {
  const records = new Map<string, LiveCommandRecord>();
  const sent: CreateOrderParams[] = [];
  let exclusiveCalls = 0;
  const journal: LiveCommandJournal = {
    async claim(record) {
      const key = `${record.accountId}/${record.commandId}`;
      const existing = records.get(key);
      if (existing) return { claimed: false, record: structuredClone(existing) };
      records.set(key, structuredClone(record));
      return { claimed: true, record };
    },
    async save(record) { records.set(`${record.accountId}/${record.commandId}`, structuredClone(record)); },
  };
  const dependencies = {
    journal,
    // Memory coordination is a test fake only. Production must serialize durably.
    async runExclusive<T>(_accountId: string, task: () => Promise<T>) {
      exclusiveCalls++;
      return task();
    },
    async readServerState() { return state; },
    now: () => at,
    transport: { async create(request: CreateOrderParams) {
      assert.equal(records.get('test-account/test-command')?.reason, 'SUBMISSION_STARTED');
      sent.push(request);
      if (failTransport) throw new Error('Synthetic ambiguous timeout');
      return { id: 'synthetic-order-id' };
    } },
  };
  return { adapter: createLiveExecutionAdapter(dependencies), dependencies,
    records, sent, exclusiveCalls: () => exclusiveCalls };
}

test('YES and NO buy/sell map intent and complement ONLY NO wire price', () => {
  for (const action of ['BUY', 'SELL'] as const) {
    for (const side of ['YES', 'NO'] as const) {
      const request = toUSLimitOrder(command({ action, side, limitPrice: 0.83 }));
      assert.equal(request.intent, `ORDER_INTENT_${action}_${side === 'YES' ? 'LONG' : 'SHORT'}`);
      assert.equal(request.price?.value, side === 'YES' ? '0.83' : '0.17');
      assert.equal(request.type, 'ORDER_TYPE_LIMIT');
      assert.equal(request.tif, 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL');
      assert.equal(request.manualOrderIndicator, 'MANUAL_ORDER_INDICATOR_MANUAL');
      assert.equal('clientOrderId' in request, false);
      assert.equal('slippageTolerance' in request, false);
    }
  }
});

test('HTTP acknowledgment remains pending, never creates a fill, and duplicate ID does not resend', async () => {
  const h = harness();
  const first = await h.adapter.submit(command());
  assert.equal(first.record.state, 'pending');
  assert.equal(first.requiresReconciliation, true);
  assert.equal(first.record.orderId, 'synthetic-order-id');
  const second = await h.adapter.submit(command());
  assert.equal(second.replayed, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.exclusiveCalls(), 2);
  await assert.rejects(h.adapter.submit(command({ quantity: 21 })), /COMMAND_ID_CONFLICT/);
  assert.equal(h.sent.length, 1);
});

test('timeout is unknown and persistent duplicate prevention survives adapter recreation', async () => {
  const h = harness(readiness(), true);
  const first = await h.adapter.submit(command());
  assert.equal(first.record.state, 'unknown');
  assert.equal(first.requiresReconciliation, true);
  const restarted = createLiveExecutionAdapter(h.dependencies);
  assert.equal((await restarted.submit(command())).record.state, 'unknown');
  assert.equal(h.sent.length, 1);
});

test('crash after durable claim never resends an ambiguous submission', async () => {
  const h = harness();
  await h.adapter.submit(command());
  const record = h.records.get('test-account/test-command')!;
  h.records.set('test-account/test-command', { ...record, state: 'submitting', orderId: undefined });
  const result = await h.adapter.submit(command());
  assert.equal(result.replayed, true);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(h.sent.length, 1);
});

test('missing account, credential, validation, arming and reconciliation gates never call transport', async () => {
  const cases: [Partial<LiveReadiness>, string][] = [
    [{ credentialsConfigured: false }, 'ACCOUNT_NOT_CONFIGURED'],
    [{ configuredAccountId: 'someone-else' }, 'ACCOUNT_MISMATCH'],
    [{ authenticatedContractValidated: false }, 'AUTHENTICATED_CONTRACT_NOT_VALIDATED'],
    [{ liveArmed: false }, 'LIVE_NOT_ARMED'],
    [{ privateStreamConnected: false }, 'STREAM_NOT_READY'],
    [{ bookSynchronized: false }, 'STREAM_NOT_READY'],
    [{ lastPrivateHeartbeatAt: at - 6_000 }, 'STREAM_STALE'],
    [{ lastMarketHeartbeatAt: at + 1 }, 'STREAM_STALE'],
    [{ accountReconciled: false }, 'ACCOUNT_NOT_RECONCILED'],
    [{ connectionEpoch: 'new-connection' }, 'ACCOUNT_NOT_RECONCILED'],
    [{ hasUnresolvedCommand: true }, 'UNRESOLVED_COMMAND'],
    [{ conflictingOrdersReconciled: false }, 'CONFLICTING_ORDERS'],
    [{ marketSlug: 'wrong-market' }, 'MARKET_OUT_OF_SCOPE'],
    [{ marketOpen: false }, 'MARKET_CLOSED'],
    [{ availableCashUsd: NaN }, 'INVALID_ACCOUNT_STATE'],
  ];
  for (const [change, reason] of cases) {
    const h = harness(readiness(change));
    assert.equal((await h.adapter.submit(command())).record.reason, reason);
    assert.equal(h.sent.length, 0);
  }
});

test('automated source needs its own arming and exact regulatory indicator', async () => {
  const unarmed = harness();
  assert.equal((await unarmed.adapter.submit(command({ source: 'AUTOMATIC' }))).record.reason,
    'AUTOMATION_NOT_ARMED');
  const armed = harness(readiness({ automationArmed: true }));
  await armed.adapter.submit(command({ source: 'AUTOMATIC' }));
  assert.equal(armed.sent[0].manualOrderIndicator, 'MANUAL_ORDER_INDICATOR_AUTOMATIC');
});

test('BUY checks budget including fees and exposure limits before submission', async () => {
  const cases: [Partial<LiveReadiness>, Partial<LiveOrderCommand>, string][] = [
    [{ availableCashUsd: 8 }, {}, 'INSUFFICIENT_CASH'],
    [{ marketExposureUsd: 29 }, {}, 'MARKET_EXPOSURE_LIMIT'],
    [{ totalExposureUsd: 59 }, {}, 'ACCOUNT_EXPOSURE_LIMIT'],
    [{}, { budgetUsd: 8 }, 'BUDGET_EXCEEDED'],
    [{}, { createdAt: at - 2_001 }, 'COMMAND_EXPIRED'],
    [{}, { createdAt: at + 1 }, 'COMMAND_EXPIRED'],
    [{}, { limitPrice: 0.405 }, 'PRICE_OFF_INCREMENT'],
    [{}, { quantity: 0.5 }, 'QUANTITY_OFF_INCREMENT'],
  ];
  for (const [state, changes, reason] of cases) {
    const h = harness(readiness(state));
    assert.equal((await h.adapter.submit(command(changes))).record.reason, reason);
    assert.equal(h.sent.length, 0);
  }
});

test('partial NO exit uses SELL_SHORT with explicit quantity and complementary price', async () => {
  const h = harness(readiness({ availableQuantity: 2.5, minimumTradeQty: 0.5 }));
  const result = await h.adapter.submit(command({ action: 'SELL', side: 'NO',
    quantity: 1.5, limitPrice: 0.7, budgetUsd: undefined }));
  assert.equal(result.record.state, 'pending');
  assert.equal(h.sent[0].intent, 'ORDER_INTENT_SELL_SHORT');
  assert.equal(h.sent[0].price?.value, '0.3');
  assert.equal(h.sent[0].quantity, 1.5);
});

test('SELL cannot create a short position and manual exit requires bot reentry pause', async () => {
  const insufficient = harness(readiness({ availableQuantity: 2 }));
  assert.equal((await insufficient.adapter.submit(command({ action: 'SELL', quantity: 3 }))).record.reason,
    'INSUFFICIENT_POSITION');
  const runningBot = harness(readiness({ manualExitReentryPaused: false }));
  assert.equal((await runningBot.adapter.submit(command({ action: 'SELL' }))).record.reason,
    'PAUSE_REENTRY_BEFORE_MANUAL_EXIT');
  assert.equal(insufficient.sent.length + runningBot.sent.length, 0);
});

test('failed journal persistence before network means no order is sent', async () => {
  const h = harness();
  h.dependencies.journal.save = async () => { throw new Error('Synthetic storage failure'); };
  await assert.rejects(h.adapter.submit(command()), /storage failure/);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.adapter.submit(command())).requiresReconciliation, true);
});

test('journal persistence failure after acknowledgment is unknown and never resubmits', async () => {
  const h = harness();
  const originalSave = h.dependencies.journal.save;
  h.dependencies.journal.save = async record => {
    if (record.state === 'pending') throw new Error('Synthetic post-submit storage failure');
    await originalSave(record);
  };
  const result = await h.adapter.submit(command());
  assert.equal(result.record.state, 'unknown');
  assert.equal(result.record.reason, 'JOURNAL_WRITE_FAILED');
  assert.equal(result.record.orderId, 'synthetic-order-id');
  assert.equal((await h.adapter.submit(command())).replayed, true);
  assert.equal(h.sent.length, 1);
});

test('malformed acknowledgment cannot be mistaken for a rejection or successful fill', async () => {
  const h = harness();
  h.dependencies.transport.create = async () => ({ id: '' });
  assert.equal((await h.adapter.submit(command())).record.state, 'unknown');
});

test('concurrent repeated command IDs still send only once with atomic journal claim', async () => {
  const h = harness();
  const results = await Promise.all([h.adapter.submit(command()), h.adapter.submit(command())]);
  assert.equal(h.sent.length, 1);
  assert.equal(results.filter(result => result.replayed).length, 1);
});

test('disarming during journal persistence is checked again before transport', async () => {
  const state = readiness();
  const h = harness(state);
  const save = h.dependencies.journal.save;
  h.dependencies.journal.save = async record => {
    await save(record);
    if (record.reason === 'SUBMISSION_STARTED') state.liveArmed = false;
  };
  const result = await h.adapter.submit(command());
  assert.equal(result.record.reason, 'LIVE_NOT_ARMED');
  assert.equal(h.sent.length, 0);
});

test('serialization never silently rounds an unsupported limit to a worse price', () => {
  assert.throws(() => toUSLimitOrder(command({ limitPrice: 0.123456789 })),
    /UNSUPPORTED_PRICE_PRECISION/);
});
