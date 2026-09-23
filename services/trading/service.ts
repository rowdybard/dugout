import { PolymarketUS, type MarketsWebSocket, type PrivateWebSocket } from "polymarket-us";
import type { StreamSelection, StreamAccount, StreamHealth } from "../../lib/trading/stream-types.ts";
import {
  selectionsSchema, ordersResponseSchema, positionsResponseSchema, balancesResponseSchema,
  normalizeBalance, normalizeOrder, normalizePosition,
} from "./contracts.ts";
import { StreamState, type Channel } from "./state.ts";

type Socket = MarketsWebSocket | PrivateWebSocket;
export type TradingStreamOptions = {
  keyId?: string;
  secretKey?: string;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
};

/** Authenticated streaming and read-only reconciliation. No create/cancel/modify order methods. */
export class TradingStreamService {
  readonly state: StreamState;
  private readonly client: PolymarketUS | null;
  private readonly sockets: Partial<Record<Channel, Socket>> = {};
  private readonly generations: Record<Channel, number> = { market: 0, private: 0 };
  private readonly attempts: Record<Channel, number> = { market: 0, private: 0 };
  private readonly retries: Partial<Record<Channel, ReturnType<typeof setTimeout>>> = {};
  private readonly requestIds = new Set<string>();
  private readonly idleTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly owners = new Map<string, StreamSelection[]>();
  private readonly ownerLeases = new Map<string, { connections: number; expiresAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private reconciling = false;
  private reconcileFailures = 0;
  private lastRestAt = 0;
  private restTail: Promise<unknown> = Promise.resolve();

  constructor(options: TradingStreamOptions = {}) {
    const configured = Boolean(options.keyId && options.secretKey);
    this.client = configured ? new PolymarketUS({ keyId: options.keyId, secretKey: options.secretKey, timeout: 12000 }) : null;
    this.state = new StreamState(configured);
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15000;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.client) { void this.connect("market"); void this.connect("private"); }
    else this.state.publishStatus();
    this.timer = setInterval(() => {
      for (const [ownerId, lease] of this.ownerLeases) {
        if (lease.connections === 0 && lease.expiresAt <= Date.now()) this.setSubscriptions([], ownerId);
      }
      for (const channel of this.state.checkHealth(this.idleTimeoutMs)) this.reconnect(channel, "Provider keep-alive timed out.");
      const reconciliation = this.state.health.reconciliation;
      if (reconciliation.state === "pending" || (reconciliation.lastAt !== null && Date.now() - reconciliation.lastAt > 60000)) this.scheduleReconciliation();
      this.state.publishStatus();
    }, 5000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    for (const channel of ["market", "private"] as const) {
      if (this.retries[channel]) clearTimeout(this.retries[channel]);
      this.generations[channel]++;
      this.sockets[channel]?.close();
      this.state.disconnected(channel, "stopped", "Streaming service stopped.");
    }
  }

  /** Callers must derive league membership from the server's verified MLB/NFL catalogue. */
  setSubscriptions(input: unknown, ownerId = "application") {
    if (!/^[a-zA-Z0-9_.:-]{1,400}$/.test(ownerId)) throw new Error("Invalid subscription owner ID.");
    const selections = selectionsSchema.parse(input);
    if (!this.owners.has(ownerId) && this.owners.size >= 32) throw new Error("Subscription owner capacity reached.");
    const owners = new Map(this.owners);
    if (selections.length) owners.set(ownerId, selections); else owners.delete(ownerId);
    const merged = new Map<string, StreamSelection>();
    for (const group of owners.values()) for (const selection of group) {
      const previous = merged.get(selection.slug);
      if (previous && previous.league !== selection.league) throw new Error("Conflicting market league membership.");
      if (!previous || selection.detail === "book") merged.set(selection.slug, selection);
    }
    const validated = selectionsSchema.parse([...merged.values()].sort((a, b) => a.slug.localeCompare(b.slug)));
    this.owners.clear();
    for (const [owner, markets] of owners) this.owners.set(owner, markets);
    if (selections.length) this.ownerLeases.set(ownerId, { connections: this.ownerLeases.get(ownerId)?.connections ?? 0, expiresAt: Date.now() + 60000 });
    else this.ownerLeases.delete(ownerId);
    const old = JSON.stringify([...this.state.selections.values()]);
    if (old !== JSON.stringify(validated)) {
      this.state.setSelections(validated);
      if (this.sockets.market?.isConnected) this.subscribeMarkets();
    }
    return this.state.snapshot();
  }

  /** Keep a selection lease while its authenticated SSE reader is connected. */
  attachSubscriptionOwner(ownerId: string) {
    const lease = this.ownerLeases.get(ownerId);
    if (!lease) throw new Error("Unknown subscription owner.");
    lease.connections++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.ownerLeases.get(ownerId);
      if (current) { current.connections = Math.max(0, current.connections - 1); current.expiresAt = Date.now() + 60000; }
    };
  }

  private async connect(channel: Channel) {
    if (this.stopped || !this.client) return;
    const generation = ++this.generations[channel];
    const socket = channel === "market" ? this.client.ws.markets() : this.client.ws.private();
    this.sockets[channel] = socket;
    const current = () => !this.stopped && this.generations[channel] === generation;
    const onMessage = (input: unknown) => {
      if (!current()) return;
      if (channel === "market") {
        if (typeof input === "object" && input !== null && "requestId" in input && !this.requestIds.has(String(input.requestId))) {
          // Frames from a replaced subscription are not current state.
          return;
        }
        this.state.ingestMarket(input);
      } else {
        this.state.ingestPrivate(input);
        if (this.state.health.reconciliation.state === "pending") this.scheduleReconciliation();
      }
      if (this.state.health[channel].lastMessageAt !== null) this.attempts[channel] = 0;
    };
    const onClose = () => { if (current()) this.reconnect(channel, "Provider connection closed; snapshots must be renewed."); };
    const onError = () => {
      // Never send SDK errors or authentication headers to clients/logs.
      if (current()) this.reconnect(channel, "Provider connection or subscription failed.");
    };
    if (channel === "market") {
      const observer = socket as MarketsWebSocket;
      observer.on("message", onMessage); observer.on("close", onClose); observer.on("error", onError);
    } else {
      const observer = socket as PrivateWebSocket;
      observer.on("message", onMessage); observer.on("close", onClose); observer.on("error", onError);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        socket.connect(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Connection timeout")), this.connectTimeoutMs); }),
      ]);
      if (!current()) { socket.close(); return; }
      this.state.connected(channel);
      if (channel === "market") this.subscribeMarkets();
      else {
        const privateSocket = socket as PrivateWebSocket;
        privateSocket.subscribeOrders(`orders-${generation}`);
        privateSocket.subscribePositions(`positions-${generation}`);
        privateSocket.subscribeAccountBalance(`balances-${generation}`);
        this.scheduleReconciliation(0);
      }
    } catch {
      if (current()) this.reconnect(channel, "Could not establish authenticated provider connection.");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private reconnect(channel: Channel, reason: string) {
    if (this.stopped || this.retries[channel]) return;
    this.generations[channel]++;
    this.sockets[channel]?.close();
    delete this.sockets[channel];
    this.state.disconnected(channel, "reconnecting", reason);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts[channel]++, 5)) + Math.floor(Math.random() * 500);
    this.retries[channel] = setTimeout(() => { delete this.retries[channel]; void this.connect(channel); }, delay);
  }

  private subscribeMarkets() {
    const socket = this.sockets.market as MarketsWebSocket | undefined;
    if (!socket?.isConnected) return;
    try {
      for (const id of this.requestIds) socket.unsubscribe(id);
      this.requestIds.clear();
      const revision = `${this.generations.market}-${Date.now()}`;
      for (const detail of ["book", "lite"] as const) {
        const slugs = [...this.state.selections.values()].filter((selection) => selection.detail === detail).map((selection) => selection.slug);
        for (let i = 0; i < slugs.length; i += 100) {
          const id = `${detail}-${revision}-${i / 100}`;
          this.requestIds.add(id);
          if (detail === "book") socket.subscribeMarketData(id, slugs.slice(i, i + 100));
          else socket.subscribeMarketDataLite(id, slugs.slice(i, i + 100));
          if (detail === "book") {
            const tradeId = `trade-${revision}-${i / 100}`;
            this.requestIds.add(tradeId);
            socket.subscribeTrades(tradeId, slugs.slice(i, i + 100));
          }
        }
      }
    } catch { this.reconnect("market", "Could not restore market subscriptions."); }
  }

  requestReconciliation() {
    if (!this.client) return;
    this.state.pendingReconciliation("Manual account reconciliation requested.");
    this.state.publishStatus();
    this.scheduleReconciliation(0);
  }

  private scheduleReconciliation(delay = 750) {
    if (this.stopped || !this.client || this.reconciling || this.reconcileTimer || this.state.health.private.state !== "connected") return;
    this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; void this.reconcile(); }, delay);
  }

  /** 5 read requests/s maximum from this service; reserve provider capacity for later execution. */
  private read<T>(fn: () => Promise<T>): Promise<T> {
    const promise = this.restTail.then(async () => {
      const wait = Math.max(0, 200 - (Date.now() - this.lastRestAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (this.stopped) throw new Error("Service stopped");
      this.lastRestAt = Date.now();
      return fn();
    });
    this.restTail = promise.catch(() => undefined);
    return promise;
  }

  private async reconcile() {
    if (this.reconciling || !this.client || this.stopped) return;
    this.reconciling = true;
    const revision = this.state.accountRevision;
    this.state.health.reconciliation.state = "running";
    this.state.publishStatus();
    let retryDelay = 1500;
    try {
      const orders = ordersResponseSchema.parse(await this.read(() => this.client!.orders.list()));
      const positions: StreamAccount["positions"] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = positionsResponseSchema.parse(await this.read(() => this.client!.portfolio.positions({ limit: 100, ...(cursor ? { cursor } : {}) })));
        for (const [slug, value] of Object.entries(result.positions)) positions.push(normalizePosition(slug, value));
        if (result.eof === true || !result.nextCursor) {
          if (result.eof === false && !result.nextCursor) throw new Error("Incomplete positions pagination");
          break;
        }
        if (seenCursors.has(result.nextCursor) || page === 99) throw new Error("Positions pagination did not finish");
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      const balances = balancesResponseSchema.parse(await this.read(() => this.client!.account.balances()));
      this.state.reconciled({ orders: orders.orders.map(normalizeOrder), positions,
        balances: balances.balances.map(normalizeBalance), reconciledAt: null }, revision);
      this.reconcileFailures = 0;
    } catch {
      retryDelay = Math.min(60000, 2000 * 2 ** Math.min(this.reconcileFailures++, 5));
      this.state.health.reconciliation.state = "failed";
      this.state.health.reconciliation.reason = "Authoritative account reconciliation failed; account is not ready.";
      this.state.publishStatus();
    } finally {
      this.reconciling = false;
      if ((this.state.health.reconciliation as StreamHealth["reconciliation"]).state !== "ready") this.scheduleReconciliation(retryDelay);
    }
  }
}
