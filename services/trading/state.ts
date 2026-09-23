import type {
  StreamAccount, StreamEvent, StreamHealth, StreamQuote, StreamSelection, StreamSnapshot, StreamSocketHealth,
} from "../../lib/trading/stream-types.ts";
import {
  marketMessageSchema, privateMessageSchema, normalizeBalance, normalizeOrder, normalizePosition,
} from "./contracts.ts";

const socketHealth = (configured: boolean): StreamSocketHealth => ({
  state: configured ? "connecting" : "not_configured", connectedAt: null,
  lastMessageAt: null, lastHeartbeatAt: null, reconnects: 0, rejectedMessages: 0,
  reason: configured ? null : "Set server-side POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY to connect.",
});
const terminalOrders = new Set(["ORDER_STATE_FILLED", "ORDER_STATE_CANCELED", "ORDER_STATE_REJECTED", "ORDER_STATE_EXPIRED"]);
/** Source clocks may lead our receipt clock slightly; this is not a freshness exemption. */
export const MAX_SOURCE_CLOCK_LEAD_MS = 2000;
export type Channel = "market" | "private";

/** Pure, injectable-clock state machine. It has no order submission capability. */
export class StreamState {
  readonly health: StreamHealth;
  readonly selections = new Map<string, StreamSelection>();
  readonly quotes = new Map<string, StreamQuote>();
  account: StreamAccount = { positions: [], orders: [], balances: [], reconciledAt: null };
  /** Changes on every validated private state event, used to reject raced REST snapshots. */
  accountRevision = 0;
  private readonly listeners = new Set<(event: StreamEvent) => void>();
  private readonly lastTradeTimes = new Map<string, number>();
  private readonly executionIds = new Set<string>();
  private readonly terminalOrderIds = new Set<string>();
  private readonly orderTimes = new Map<string, number>();
  private readonly balanceTimes = new Map<string, number>();
  private readonly now: () => number;

  constructor(configured: boolean, now: () => number = Date.now) {
    this.now = now;
    this.health = {
      configured, mode: "read_only", liveExecution: false, authenticatedContractVerified: false,
      market: socketHealth(configured), private: socketHealth(configured), selectedMarkets: 0,
      reconciliation: { state: configured ? "pending" : "not_configured", lastAt: null, reason: null },
      updatedAt: now(),
    };
  }

  onEvent(listener: (event: StreamEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: StreamEvent) {
    for (const listener of this.listeners) listener(event);
  }

  publishStatus() {
    this.health.updatedAt = this.now();
    this.emit({ type: "status", data: structuredClone(this.health) });
  }

  setSelections(selections: StreamSelection[]) {
    const previous = new Map(this.selections);
    this.selections.clear();
    for (const selection of selections) {
      this.selections.set(selection.slug, selection);
      if (previous.get(selection.slug)?.detail !== selection.detail) {
        const quote = this.quotes.get(selection.slug);
        if (quote) quote.valid = false;
      }
    }
    for (const slug of this.quotes.keys()) {
      if (!this.selections.has(slug)) {
        this.quotes.delete(slug);
        this.lastTradeTimes.delete(slug);
      }
    }
    this.health.selectedMarkets = selections.length;
    this.publishStatus();
  }

  connected(channel: Channel) {
    Object.assign(this.health[channel], {
      state: "connected", connectedAt: this.now(), lastMessageAt: null, lastHeartbeatAt: null, reason: null,
    });
    if (channel === "private") this.pendingReconciliation("Private stream connected; checking authoritative account state.");
    this.publishStatus();
  }

  disconnected(channel: Channel, state: "stale" | "reconnecting" | "error" | "stopped", reason: string) {
    this.health[channel].state = state;
    this.health[channel].reason = reason;
    if (state === "reconnecting") this.health[channel].reconnects++;
    if (channel === "market") {
      for (const quote of this.quotes.values()) {
        quote.valid = false;
        this.emit({ type: "quote", data: structuredClone(quote) });
      }
    } else {
      this.accountRevision++;
      this.pendingReconciliation(reason);
    }
    this.publishStatus();
  }

  /** A quiet price is fine; lack of transport messages/heartbeats is a separate failure. */
  checkHealth(idleTimeoutMs: number): Channel[] {
    const stale: Channel[] = [];
    for (const channel of ["market", "private"] as const) {
      const socket = this.health[channel];
      if (socket.state !== "connected") continue;
      const lastEvidence = socket.lastMessageAt ?? socket.connectedAt;
      if (lastEvidence !== null && this.now() - lastEvidence > idleTimeoutMs) {
        this.disconnected(channel, "stale", "No provider message or heartbeat within the connection timeout.");
        stale.push(channel);
      }
    }
    return stale;
  }

  reject(channel: Channel, reason: string) {
    this.health[channel].rejectedMessages++;
    this.health[channel].reason = reason;
    if (channel === "private") {
      this.accountRevision++;
      this.pendingReconciliation(reason);
    } else {
      // A protocol gap makes the prior books uncertain until a fresh valid snapshot arrives.
      for (const quote of this.quotes.values()) {
        quote.valid = false;
        this.emit({ type: "quote", data: structuredClone(quote) });
      }
    }
    this.publishStatus();
    return false;
  }

  private accepted(channel: Channel, heartbeat: boolean) {
    const socket = this.health[channel];
    socket.lastMessageAt = this.now();
    if (heartbeat) socket.lastHeartbeatAt = this.now();
  }

  ingestMarket(input: unknown): boolean {
    const result = marketMessageSchema.safeParse(input);
    if (!result.success) return this.reject("market", "Unrecognized US market message; adapter contract needs review.");
    const message = result.data;
    if ("error" in message) return this.reject("market", "Provider rejected a market subscription.");
    this.accepted("market", "heartbeat" in message);
    if ("heartbeat" in message) return true;
    if ("trade" in message) {
      const trade = message.trade;
      if (!this.selections.has(trade.marketSlug)) return this.reject("market", "Received trade for an unselected market.");
      const sourceTime = Date.parse(trade.tradeTime);
      if (sourceTime > this.now() + MAX_SOURCE_CLOCK_LEAD_MS) return this.reject("market", "Provider trade clock is ahead of the allowed clock skew.");
      if (sourceTime < (this.lastTradeTimes.get(trade.marketSlug) ?? 0)) return false;
      this.lastTradeTimes.set(trade.marketSlug, sourceTime);
      this.emit({ type: "trade", data: { slug: trade.marketSlug, price: trade.price.value,
        quantity: trade.quantity.value, sourceTime, receivedAt: this.now() } });
      return true;
    }
    const full = "marketData" in message ? message.marketData : null;
    const lite = "marketDataLite" in message ? message.marketDataLite : null;
    const slug = (full ?? lite)!.marketSlug;
    const selection = this.selections.get(slug);
    if (!selection) return this.reject("market", "Received quote for an unselected market.");
    const previous = this.quotes.get(slug);
    const sourceTime = full?.transactTime ? Date.parse(full.transactTime) : null;
    if (sourceTime !== null && sourceTime > this.now() + MAX_SOURCE_CLOCK_LEAD_MS) return this.reject("market", "Provider book clock is ahead of the allowed clock skew.");
    if (sourceTime !== null && previous?.sourceTime !== null && previous?.sourceTime !== undefined && sourceTime < previous.sourceTime) return false;
    const bidDecimal = full ? full.bids[0]?.px.value ?? null : lite?.bestBid?.value ?? null;
    const askDecimal = full ? full.offers[0]?.px.value ?? null : lite?.bestAsk?.value ?? null;
    if (bidDecimal !== null && askDecimal !== null && Number(bidDecimal) > Number(askDecimal)) {
      return this.reject("market", "Crossed book received; waiting for a valid snapshot.");
    }
    if (full && (full.bids.some((level, i) => i > 0 && Number(level.px.value) > Number(full.bids[i - 1].px.value)) ||
      full.offers.some((level, i) => i > 0 && Number(level.px.value) < Number(full.offers[i - 1].px.value)))) {
      return this.reject("market", "Unsorted book received; waiting for a valid snapshot.");
    }
    const lastTradeDecimal = full?.stats?.lastTradePx?.value ?? lite?.lastTradePx?.value ?? null;
    const priceDecimal = lite?.currentPx?.value ?? lastTradeDecimal;
    const price = priceDecimal === null ? null : Number(priceDecimal);
    const quote: StreamQuote = {
      slug, league: selection.league, bidDecimal, askDecimal, priceDecimal,
      bid: bidDecimal === null ? null : Number(bidDecimal), ask: askDecimal === null ? null : Number(askDecimal), price,
      priceKind: lite?.currentPx ? "current" : lastTradeDecimal !== null ? "last_trade" : null,
      lastTradeDecimal,
      book: full ? {
        bids: full.bids.map((level) => ({ price: level.px.value, quantity: level.qty })),
        asks: full.offers.map((level) => ({ price: level.px.value, quantity: level.qty })),
      } : null,
      state: full?.state ?? null, sharesTraded: full?.stats?.sharesTraded ?? lite?.sharesTraded ?? null,
      sourceTime, receivedAt: this.now(), lastPriceChangeAt: price === null ? previous?.lastPriceChangeAt ?? null : price !== previous?.price ? this.now() : previous.lastPriceChangeAt,
      valid: this.health.market.state === "connected", source: "polymarket_us_websocket",
    };
    this.quotes.set(slug, quote);
    this.emit({ type: "quote", data: structuredClone(quote) });
    return true;
  }

  ingestPrivate(input: unknown): boolean {
    const parsed = privateMessageSchema.safeParse(input);
    if (!parsed.success) return this.reject("private", "Unrecognized US account message; a REST reconciliation is required.");
    const message = parsed.data;
    if ("error" in message) return this.reject("private", "Provider rejected an account subscription.");
    this.accepted("private", "heartbeat" in message);
    if ("heartbeat" in message) return true;
    this.accountRevision++;
    // No verified sequence/watermark exists across the REST and private socket contracts.
    // Emit timely account observations, but do not treat them as execution-ready balances.
    this.pendingReconciliation("Account update received; confirming authoritative state.");
    if ("orderSubscriptionUpdate" in message) {
      const execution = message.orderSubscriptionUpdate.execution;
      if (this.executionIds.has(execution.id)) return true;
      this.executionIds.add(execution.id);
      if (this.executionIds.size > 10000) this.executionIds.delete(this.executionIds.values().next().value!);
      const order = normalizeOrder(execution.order);
      const sourceTime = execution.transactTime ? Date.parse(execution.transactTime) : null;
      if (sourceTime === null || sourceTime < (this.account.reconciledAt ?? 0)) return false;
      if (sourceTime !== null && (sourceTime > this.now() + MAX_SOURCE_CLOCK_LEAD_MS || sourceTime < (this.orderTimes.get(order.id) ?? 0))) return false;
      if (this.terminalOrderIds.has(order.id) && !terminalOrders.has(order.state)) return false;
      if (sourceTime !== null) this.orderTimes.set(order.id, sourceTime);
      if (terminalOrders.has(order.state)) this.terminalOrderIds.add(order.id);
      if (this.terminalOrderIds.size > 10000) this.terminalOrderIds.delete(this.terminalOrderIds.values().next().value!);
      this.account.orders = this.account.orders.filter((existing) => existing.id !== order.id);
      if (!terminalOrders.has(order.state)) this.account.orders.push(order);
    } else if ("accountBalancesUpdate" in message) {
      const change = message.accountBalancesUpdate.balanceChange;
      const balance = normalizeBalance(change.afterBalance);
      const sourceTime = change.updateTime ? Date.parse(change.updateTime) : null;
      // Timestamp-free changes trigger REST, rather than rolling known cash backwards.
      if (sourceTime === null || sourceTime > this.now() + MAX_SOURCE_CLOCK_LEAD_MS || sourceTime < Math.max(this.balanceTimes.get(balance.currency) ?? 0, this.account.reconciledAt ?? 0)) return false;
      this.balanceTimes.set(balance.currency, sourceTime);
      this.account.balances = this.account.balances.filter((existing) => existing.currency !== balance.currency);
      this.account.balances.push(balance);
    } else if ("accountBalancesSnapshot" in message) {
      this.pendingReconciliation("Balance snapshot received; reconciling complete REST account state.");
    } else if ("positionSubscriptionUpdate" in message) {
      const update = message.positionSubscriptionUpdate;
      this.applyPosition(update.marketSlug, normalizePosition(update.marketSlug, update.position));
    } else if ("positionSubscription" in message) {
      const update = message.positionSubscription;
      const slug = update.afterPosition.marketMetadata?.slug;
      if (slug) this.applyPosition(slug, normalizePosition(slug, { ...update.afterPosition, updateTime: update.updateTime ?? update.afterPosition.updateTime }));
      else this.pendingReconciliation("Position event has no documented market identifier; fetching authoritative positions.");
    } else {
      // Paginated snapshots have no verified sequence/watermark. REST reconciliation owns replacement.
      this.pendingReconciliation("Account subscription snapshot received; reconciling complete REST state.");
    }
    this.emit({ type: "account", data: structuredClone(this.account) });
    return true;
  }

  private applyPosition(slug: string, position: StreamAccount["positions"][number]) {
    const previous = this.account.positions.find((existing) => existing.slug === slug);
    if (position.sourceTime === null || position.sourceTime > this.now() + MAX_SOURCE_CLOCK_LEAD_MS || position.sourceTime < (this.account.reconciledAt ?? 0)) {
      this.pendingReconciliation("Position time is missing or ahead of the allowed clock skew; refreshing account state.");
      return;
    }
    if (previous?.sourceTime !== null && previous?.sourceTime !== undefined && position.sourceTime !== null && position.sourceTime < previous.sourceTime) {
      this.pendingReconciliation("Out-of-order position event; refreshing account state.");
      return;
    }
    this.account.positions = this.account.positions.filter((existing) => existing.slug !== slug);
    this.account.positions.push(position);
  }

  pendingReconciliation(reason: string) {
    if (!this.health.configured) return;
    this.health.reconciliation.state = "pending";
    this.health.reconciliation.reason = reason;
  }

  reconciled(account: StreamAccount, expectedRevision: number): boolean {
    if (this.health.private.state !== "connected" || expectedRevision !== this.accountRevision) {
      this.pendingReconciliation("Account changed during REST reconciliation; checking again before marking ready.");
      this.publishStatus();
      return false;
    }
    this.account = { ...account, reconciledAt: this.now() };
    this.health.reconciliation = { state: "ready", lastAt: this.now(), reason: null };
    this.emit({ type: "account", data: structuredClone(this.account) });
    this.publishStatus();
    return true;
  }

  snapshot(slugs?: Set<string>): StreamSnapshot {
    const allowed = (slug: string) => this.selections.has(slug) && (!slugs || slugs.has(slug));
    return {
      health: structuredClone(this.health),
      quotes: [...this.quotes.values()].filter((quote) => allowed(quote.slug)).map((quote) => structuredClone(quote)),
      account: { ...structuredClone(this.account),
        positions: this.account.positions.filter((position) => allowed(position.slug)).map((position) => structuredClone(position)),
        orders: this.account.orders.filter((order) => allowed(order.slug)).map((order) => structuredClone(order)),
      },
    };
  }
}
