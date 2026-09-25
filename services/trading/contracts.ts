import { z } from "zod";
import type { StreamBalance, StreamOrder, StreamPosition } from "../../lib/trading/stream-types.ts";

// Current US endpoint contracts, checked 2026-09-23. Never accept global/CLOB envelopes.
// Strings are retained for money and fractional quantities; JS numbers are display-only.
export const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).max(80);
const unsignedDecimal = decimal.refine((value) => !value.startsWith("-"), "Nonnegative decimal required");
const priceValue = unsignedDecimal.refine((value) => Number(value) <= 1, "Binary price must be within 0..1");
const amount = z.object({ value: decimal, currency: z.literal("USD") });
const price = z.object({ value: priceValue, currency: z.literal("USD") });
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
export const slugSchema = z.string().min(1).max(250).regex(/^[a-zA-Z0-9._:-]+$/);
export const selectionSchema = z.object({
  slug: slugSchema,
  league: z.enum(["MLB", "NFL", "ATP", "WTA"]),
  detail: z.enum(["book", "lite"]),
}).strict();
export const selectionsSchema = z.array(selectionSchema).max(500).refine(
  (selections) => new Set(selections.map((selection) => selection.slug)).size === selections.length,
  "Duplicate market selections",
);
const level = z.object({ px: price, qty: unsignedDecimal });
const metadata = z.object({ slug: slugSchema.optional() }).passthrough();
const scalarQuantity = z.union([unsignedDecimal, z.number().finite().nonnegative()]);
export const orderSchema = z.object({
  id: z.string().min(1), marketSlug: slugSchema, state: z.string().startsWith("ORDER_STATE_"),
  intent: z.enum(["ORDER_INTENT_BUY_LONG", "ORDER_INTENT_SELL_LONG", "ORDER_INTENT_BUY_SHORT", "ORDER_INTENT_SELL_SHORT"]),
  quantity: scalarQuantity, leavesQuantity: scalarQuantity,
  cumQuantity: scalarQuantity.optional(), price: price.optional(),
}).passthrough();
export const positionSchema = z.object({
  netPosition: decimal.optional(), netPositionDecimal: decimal.optional(),
  qtyAvailable: decimal.optional(), qtyAvailableDecimal: decimal.optional(),
  cost: amount.optional(), realized: amount.optional(), expired: z.boolean().optional(),
  updateTime: timestamp.optional(), marketMetadata: metadata.optional(),
}).passthrough().refine((value) => value.netPositionDecimal !== undefined || value.netPosition !== undefined, "Missing position quantity");
export const balanceSchema = z.object({
  currency: z.string().min(1).max(16), currentBalance: z.number().finite(), buyingPower: z.number().finite(),
}).passthrough();
const envelope = { requestId: z.string().min(1).max(250) };
const heartbeat = z.object({ heartbeat: z.object({}).strict() }).strict();
const error = z.object({ error: z.string(), requestId: z.string().optional() }).strict();

export const bookMessage = z.object({
  ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_MARKET_DATA"),
  marketData: z.object({
    marketSlug: slugSchema, bids: z.array(level).max(1000), offers: z.array(level).max(1000),
    state: z.string().startsWith("MARKET_STATE_"),
    stats: z.object({ lastTradePx: price.optional(), sharesTraded: unsignedDecimal.optional(), openInterest: unsignedDecimal.optional() }).optional(),
    transactTime: timestamp.optional(),
  }),
}).strict();
export const liteMessage = z.object({
  ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_MARKET_DATA_LITE"),
  marketDataLite: z.object({
    marketSlug: slugSchema, bestBid: price.optional(), bestAsk: price.optional(),
    currentPx: price.optional(), lastTradePx: price.optional(), sharesTraded: unsignedDecimal.optional(),
    openInterest: unsignedDecimal.optional(), bidDepth: z.number().finite().optional(), askDepth: z.number().finite().optional(),
  }),
}).strict();
export const tradeMessage = z.object({
  ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_TRADE"),
  trade: z.object({
    marketSlug: slugSchema, price, quantity: z.object({ value: unsignedDecimal, currency: z.literal("USD") }),
    tradeTime: timestamp,
    maker: z.object({ side: z.string(), intent: z.string() }),
    taker: z.object({ side: z.string(), intent: z.string() }),
  }),
}).strict();
export const marketMessageSchema = z.union([bookMessage, liteMessage, tradeMessage, heartbeat, error]);

export const privateMessageSchema = z.union([
  heartbeat, error,
  z.object({ ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_ORDER"), orderSubscriptionSnapshot: z.object({ orders: z.array(orderSchema), eof: z.boolean() }) }).strict(),
  z.object({ ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_ORDER"), orderSubscriptionUpdate: z.object({ execution: z.object({ id: z.string(), order: orderSchema, type: z.string().startsWith("EXECUTION_TYPE_"), lastShares: unsignedDecimal.optional(), lastPx: price.optional(), tradeId: z.string().optional(), transactTime: timestamp.optional() }) }) }).strict(),
  // Current docs: the position event may not identify its market. In that case we reconcile REST rather than guess.
  z.object({ ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_POSITION"), positionSubscription: z.object({ beforePosition: positionSchema.optional(), afterPosition: positionSchema, updateTime: timestamp.optional(), entryType: z.string().optional(), tradeId: z.string().optional() }) }).strict(),
  // Explicit SDK 0.1.1 variants; accepted only with their documented shape.
  z.object({ ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_POSITION"), positionSubscriptionSnapshot: z.object({ positions: z.record(positionSchema), eof: z.boolean() }) }).strict(),
  z.object({ ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_POSITION"), positionSubscriptionUpdate: z.object({ marketSlug: slugSchema, position: positionSchema }) }).strict(),
  z.object({ ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_ACCOUNT_BALANCE"), accountBalancesSnapshot: z.object({ balances: z.array(balanceSchema) }) }).strict(),
  z.object({ ...envelope, subscriptionType: z.literal("SUBSCRIPTION_TYPE_ACCOUNT_BALANCE"), accountBalancesUpdate: z.object({ balanceChange: z.object({ afterBalance: balanceSchema, beforeBalance: balanceSchema.optional(), updateTime: timestamp.optional() }) }) }).strict(),
]);

export const ordersResponseSchema = z.object({ orders: z.array(orderSchema) });
export const positionsResponseSchema = z.object({ positions: z.record(positionSchema), nextCursor: z.string().optional(), eof: z.boolean().optional() });
export const balancesResponseSchema = z.object({ balances: z.array(balanceSchema) });

export function normalizeOrder(value: z.infer<typeof orderSchema>): StreamOrder {
  return { id: value.id, slug: value.marketSlug, state: value.state, intent: value.intent,
    quantity: String(value.quantity), leavesQuantity: String(value.leavesQuantity),
    filledQuantity: value.cumQuantity === undefined ? null : String(value.cumQuantity), price: value.price?.value ?? null };
}
export function normalizePosition(slug: string, value: z.infer<typeof positionSchema>): StreamPosition {
  return { slug, quantity: value.netPositionDecimal ?? value.netPosition!,
    availableQuantity: value.qtyAvailableDecimal ?? value.qtyAvailable ?? null,
    quantityPrecision: value.netPositionDecimal === undefined || value.qtyAvailableDecimal === undefined ? "legacy_rounded" : "exact",
    cost: value.cost?.value ?? null, realized: value.realized?.value ?? null,
    expired: value.expired ?? null, sourceTime: value.updateTime ? Date.parse(value.updateTime) : null };
}
export function normalizeBalance(value: z.infer<typeof balanceSchema>): StreamBalance {
  return { currency: value.currency, currentBalance: String(value.currentBalance), buyingPower: String(value.buyingPower) };
}
