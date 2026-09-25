import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createTradingServer, authorized } from "./server.ts";
import { TradingStreamService } from "./service.ts";
import { privateMessageSchema } from "./contracts.ts";
import { StreamState } from "./state.ts";
import type { StreamSnapshot } from "../../lib/trading/stream-types.ts";

// All fixtures here are synthetic contract tests; none enter the application or provider.
const token = "synthetic-test-token-that-is-longer-than-32-characters";

test("unconfigured process exposes health but requires internal authentication for every data route", async () => {
  const service = new TradingStreamService();
  const { server, closeClients } = createTradingServer(service, token);
  service.start();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const health = await (await fetch(`${url}/health`)).json() as { configured: boolean; market: string; liveExecution: boolean };
    assert.equal(health.configured, false);
    assert.equal(health.market, "not_configured");
    assert.equal(health.liveExecution, false);
    assert(!JSON.stringify(health).includes(token));
    assert.equal((await fetch(`${url}/v1/snapshot`)).status, 401);
    assert.equal((await fetch(`${url}/v1/snapshot?token=${token}`)).status, 401);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const snapshot = await (await fetch(`${url}/v1/snapshot`, { headers })).json() as StreamSnapshot;
    assert.deepEqual(snapshot.quotes, []);
    assert.deepEqual(snapshot.account.positions, []);
    assert.equal(snapshot.health.reconciliation.state, "not_configured");
    const invalid = await fetch(`${url}/v1/subscriptions`, { method: "POST", headers,
      body: JSON.stringify({ markets: [{ slug: "fixture", league: "NBA", detail: "book" }] }) });
    assert.equal(invalid.status, 400);
    const valid = await fetch(`${url}/v1/subscriptions`, { method: "POST", headers,
      body: JSON.stringify({ ownerId: "test-user:fixture", markets: [{ slug: "fixture", league: "MLB", detail: "book" }] }) });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json() as StreamSnapshot).health.selectedMarkets, 1);
    assert.equal((await fetch(`${url}/v1/orders`, { method: "POST", headers, body: "{}" })).status, 404);
    const controller = new AbortController();
    const stream = await fetch(`${url}/v1/events?markets=fixture&ownerId=test-user:fixture`, { headers, signal: controller.signal });
    assert.equal(stream.status, 200);
    const first = await stream.body!.getReader().read();
    assert.match(new TextDecoder().decode(first.value), /event: snapshot/);
    controller.abort();
  } finally {
    service.stop(); closeClients(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("missing or short tokens cannot authenticate private routes", () => {
  assert.equal(authorized(`Bearer ${token}`, undefined), false);
  assert.equal(authorized("Bearer short", "short"), false);
  assert.equal(authorized(`Bearer ${token}`, token), true);
  assert.equal(authorized(`Bearer ${token}x`, token), false);
});

test("multiple owners merge subscriptions without replacing another active market", () => {
  const service = new TradingStreamService();
  service.setSubscriptions([{ slug: "fixture", league: "MLB", detail: "lite" }], "user:feed");
  service.setSubscriptions([{ slug: "fixture", league: "MLB", detail: "book" }, { slug: "other", league: "NFL", detail: "book" }], "user:detail");
  assert.equal(service.state.selections.get("fixture")?.detail, "book");
  const release = service.attachSubscriptionOwner("user:detail");
  release(); release();
  service.setSubscriptions([], "user:detail");
  assert.equal(service.state.selections.get("fixture")?.detail, "lite");
  assert.equal(service.state.selections.has("other"), false);
  assert.throws(() => service.attachSubscriptionOwner("unknown"));
});

test("current private balance envelope validates while undocumented invented shapes fail", () => {
  assert.equal(privateMessageSchema.safeParse({ requestId: "balance", subscriptionType: "SUBSCRIPTION_TYPE_ACCOUNT_BALANCE",
    accountBalancesSnapshot: { balances: [{ currency: "USD", currentBalance: 10, buyingPower: 9 }] } }).success, true);
  assert.equal(privateMessageSchema.safeParse({ requestId: "balance", subscriptionType: "SUBSCRIPTION_TYPE_ACCOUNT_BALANCE",
    accountBalancesSnapshot: { balance: 10, currency: "USD" } }).success, false);
});

test("late active order cannot resurrect a filled order and every account update requires reconciliation", () => {
  let now = 20000;
  const state = new StreamState(true, () => now);
  state.connected("private");
  state.reconciled({ positions: [], orders: [], balances: [], reconciledAt: null }, 0);
  const order = { id: "fixture-order", marketSlug: "fixture", intent: "ORDER_INTENT_BUY_LONG", quantity: 1,
    leavesQuantity: 0, cumQuantity: 1, price: { value: "0.50", currency: "USD" }, state: "ORDER_STATE_FILLED" };
  now += 100;
  assert.equal(state.ingestPrivate({ requestId: "orders", subscriptionType: "SUBSCRIPTION_TYPE_ORDER",
    orderSubscriptionUpdate: { execution: { id: "fill", order, type: "EXECUTION_TYPE_FILL", transactTime: new Date(now).toISOString() } } }), true);
  assert.equal(state.health.reconciliation.state, "pending");
  now += 100;
  assert.equal(state.ingestPrivate({ requestId: "orders", subscriptionType: "SUBSCRIPTION_TYPE_ORDER",
    orderSubscriptionUpdate: { execution: { id: "late-open", order: { ...order, state: "ORDER_STATE_NEW", leavesQuantity: 1 },
      type: "EXECUTION_TYPE_NEW", transactTime: new Date(now).toISOString() } } }), false);
  assert.equal(state.account.orders.length, 0);
});

test("old balance event cannot overwrite a reconciled cash snapshot", () => {
  const state = new StreamState(true, () => 20000);
  state.connected("private");
  state.reconciled({ positions: [], orders: [], balances: [{ currency: "USD", currentBalance: "10", buyingPower: "10" }], reconciledAt: null }, 0);
  assert.equal(state.ingestPrivate({ requestId: "balances", subscriptionType: "SUBSCRIPTION_TYPE_ACCOUNT_BALANCE",
    accountBalancesUpdate: { balanceChange: { afterBalance: { currency: "USD", currentBalance: 100, buyingPower: 100 }, updateTime: new Date(10000).toISOString() } } }), false);
  assert.equal(state.account.balances[0].currentBalance, "10");
  assert.equal(state.health.reconciliation.state, "pending");
});
