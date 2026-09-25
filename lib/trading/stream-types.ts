/** Internal Dugout contracts, not Polymarket response types. All times are UTC ms. */
export type StreamSelection = {
  slug: string;
  league: "MLB" | "NFL";
  detail: "book" | "lite";
};

export type StreamSocketState =
  | "not_configured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stale"
  | "error"
  | "stopped";

export type StreamSocketHealth = {
  state: StreamSocketState;
  connectedAt: number | null;
  lastMessageAt: number | null;
  lastHeartbeatAt: number | null;
  reconnects: number;
  rejectedMessages: number;
  reason: string | null;
};

export type StreamHealth = {
  configured: boolean;
  mode: "read_only";
  liveExecution: false;
  /** Remains false until a real authenticated session has been contract-tested. */
  authenticatedContractVerified: false;
  market: StreamSocketHealth;
  private: StreamSocketHealth;
  selectedMarkets: number;
  reconciliation: {
    state: "not_configured" | "pending" | "running" | "ready" | "failed";
    lastAt: number | null;
    reason: string | null;
  };
  updatedAt: number;
};

export type StreamLevel = { price: string; quantity: string };
export type StreamQuote = {
  slug: string;
  league: "MLB" | "NFL";
  /** Display numbers only. Execution must use the accompanying decimal strings. */
  bid: number | null;
  ask: number | null;
  price: number | null;
  bidDecimal: string | null;
  askDecimal: string | null;
  priceDecimal: string | null;
  priceKind: "current" | "last_trade" | null;
  lastTradeDecimal: string | null;
  book: { bids: StreamLevel[]; asks: StreamLevel[] } | null;
  state: string | null;
  sharesTraded: string | null;
  sourceTime: number | null;
  receivedAt: number;
  lastPriceChangeAt: number | null;
  valid: boolean;
  source: "polymarket_us_websocket";
};

export type StreamTrade = {
  slug: string;
  price: string;
  quantity: string;
  sourceTime: number;
  receivedAt: number;
};

export type StreamPosition = {
  slug: string;
  quantity: string;
  availableQuantity: string | null;
  quantityPrecision: "exact" | "legacy_rounded";
  cost: string | null;
  realized: string | null;
  expired: boolean | null;
  sourceTime: number | null;
};

export type StreamOrder = {
  id: string;
  slug: string;
  state: string;
  intent: string;
  quantity: string;
  leavesQuantity: string;
  filledQuantity: string | null;
  price: string | null;
};

export type StreamBalance = {
  currency: string;
  currentBalance: string;
  buyingPower: string;
};

export type StreamAccount = {
  positions: StreamPosition[];
  orders: StreamOrder[];
  balances: StreamBalance[];
  /** REST completion time, never the time of the last market price change. */
  reconciledAt: number | null;
};

export type StreamSnapshot = {
  health: StreamHealth;
  quotes: StreamQuote[];
  account: StreamAccount;
};

export type StreamEvent =
  | { type: "status"; data: StreamHealth }
  | { type: "quote"; data: StreamQuote }
  | { type: "trade"; data: StreamTrade }
  | { type: "account"; data: StreamAccount };

/** A display bridge to existing chart/book components. It does not imply executability. */
export function streamBookForDisplay(quote: StreamQuote) {
  if (!quote.book || !quote.valid) return null;
  return {
    bids: quote.book.bids.map((level) => ({ price: Number(level.price), quantity: Number(level.quantity) })),
    asks: quote.book.asks.map((level) => ({ price: Number(level.price), quantity: Number(level.quantity) })),
    state: quote.state ?? "UNKNOWN",
    time: new Date(quote.sourceTime ?? quote.receivedAt).toISOString(),
  };
}
