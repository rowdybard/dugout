import { z } from 'zod';
import type { Market, Profile, Book } from '@/lib/market/types';
import type { PaperCommand, ExecutionMarket, ExecutionPolicy, PaperAccount } from '@/lib/trading/types';
import type { WorkspaceOrder } from '@/lib/trading/workspace';
import { DEFAULT_TRADING_SETTINGS } from '@/lib/trading/workspace';
import { applyPaperExecution, takeManualControl } from '@/lib/trading/ledger';
import { executePaperCommand } from '@/lib/trading/execution';
import { sideBook } from '@/lib/market/paper';
import { profile, db } from './storage';
import { getFeed } from './ingestion';
import { book, metadata, numeric } from './polymarket';
import { replayData } from './replay';

export const orderRequest = z.object({
  commandId: z.string().uuid(), action: z.enum(['BUY', 'SELL']),
  slug: z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(250), side: z.enum(['YES', 'NO']),
  amount: z.number().finite().min(1).max(10000).optional(),
  positionId: z.string().uuid().optional(), percent: z.number().finite().positive().max(100).optional(),
  limitPrice: z.number().finite().positive().lt(1), mode: z.literal('paper'),
}).strict();
export type OrderRequest = z.infer<typeof orderRequest>;
export type StoredProfile = Awaited<ReturnType<typeof profile>>;
export function ensureTrading(p: Profile) {
  p.trading ??= { settings: structuredClone(DEFAULT_TRADING_SETTINGS) };
  return p.trading;
}
export async function recentOrders(userId: string) {
  const rows = await db().prepare('SELECT value FROM trading_commands WHERE user_id=? ORDER BY created_at DESC LIMIT 60').bind(userId).all<{value: string}>();
  return rows.results.map(r => JSON.parse(r.value) as WorkspaceOrder);
}
export async function priorOrder(userId: string, commandId: string, fingerprint: string) {
  const row = await db().prepare('SELECT fingerprint,value FROM trading_commands WHERE id=?').bind(`${userId}:${commandId}`).first<{fingerprint:string;value:string}>();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new Error('This command ID was already used for a different action.');
  return JSON.parse(row.value) as WorkspaceOrder;
}
export function requestFingerprint(body: OrderRequest) {
  return JSON.stringify([body.action, body.slug, body.side, body.amount ?? null, body.positionId ?? null, body.percent ?? null, body.limitPrice, body.mode]);
}
export async function loadExecutionContext(slug: string, p: Profile) {
  const feed = await getFeed();
  let market = feed.games.flatMap(g => g.markets).find(m => m.slug === slug);
  if (!market) {
    const held = p.positions.find(x => x.slug === slug && x.status === 'open');
    if (!held) throw new Error('Choose an available MLB or NFL market.');
    market = {slug, id: slug, title: held.title, question: '', rules: '', gameId: slug, game: held.game,
      league: held.league, start: '', teams: [], kind: '', bid: null, ask: null, price: null, volume: null,
      fee: held.coefficient ?? .0695, active: true, history: [], signals: [], observedAt: Date.now()} satisfies Market;
  }
  const [snapshot, meta, replay] = await Promise.all([book(slug).then(depth=>({depth,receivedAt:Date.now()})), metadata(slug), replayData()]);
  const {depth, receivedAt} = snapshot;
  const minimum = numeric(meta.minimumTradeQty);
  const tick = numeric(meta.orderPriceMinTickSize);
  const fee = numeric(meta.feeCoefficient);
  if (fee !== null) market = {...market, fee};
  const executionMarket: ExecutionMarket = {
    slug, league: market.league, active: depth.state === 'MARKET_STATE_OPEN',
    minimumTradeQty: minimum !== null && minimum > 0 ? minimum : 1,
    quantityIncrement: minimum !== null && minimum > 0 ? minimum : 1,
    priceIncrement: tick !== null && tick > 0 && tick < 1 ? tick : .01,
    feeCoefficient: market.fee,
  };
  return {market, executionMarket, depth, receivedAt, replay: !!replay};
}
export function accountFor(p: Profile, slug: string, positionId?: string): PaperAccount {
  const open = p.positions.filter(x => x.status === 'open');
  const up=(n:number)=>Math.ceil(n*1e6-1e-6)/1e6, down=(n:number)=>Math.floor(n*1e6+1e-6)/1e6;
  return {cash: down(p.cash), marketExposure: up(open.filter(x => x.slug === slug).reduce((s,x) => s+x.amount,0)),
    totalExposure: up(open.reduce((s,x) => s+x.amount,0)), availableQuantity: down(open.find(x => x.id === positionId)?.contracts ?? 0)};
}
export function policyFor(p: Profile, context: Awaited<ReturnType<typeof loadExecutionContext>>, automatic = false): ExecutionPolicy {
  return {now: Date.now(), bookReceivedAt: context.receivedAt, bookSource: context.replay ? 'REPLAY' : 'REST',
    stateCertain: true, maxBookAgeMs: 15000, maxCommandAgeMs: 20000, maxOrderBudget: automatic ? (p.trading?.automation?.config.entryBudget ?? 0) : 10000,
    maxMarketExposure: automatic ? (p.trading?.automation?.config.entryBudget ?? 0) : 10000,
    maxTotalExposure: 10000, automation: automatic ? 'PAPER' : 'OFF',
    manualTakeover: automatic && p.trading?.automation?.manualTakeover};
}
export function calculateOrder(p: Profile, body: OrderRequest, context: Awaited<ReturnType<typeof loadExecutionContext>>, automatic = false) {
  const position = p.positions.find(x => x.id === body.positionId && x.status === 'open');
  if (body.action === 'SELL' && (!position || position.slug !== body.slug || position.side !== body.side)) throw new Error('Choose an open position for this outcome.');
  if (body.action === 'BUY' && body.amount === undefined) throw new Error('Choose an entry amount.');
  const tick = context.executionMarket.priceIncrement;
  // Round toward protection: buy cap down; sell floor up. Never widen a user limit.
  const limitPrice = Math.round((body.action === 'BUY' ? Math.floor((body.limitPrice+1e-9)/tick) : Math.ceil((body.limitPrice-1e-9)/tick)) * tick * 1e6)/1e6;
  const step = context.executionMarket.quantityIncrement;
  const qty = position ? Math.round(Math.floor((position.contracts * (body.percent ?? 100) / 100 + 1e-9) / step) * step * 1e6)/1e6 : undefined;
  const command: PaperCommand = {
    commandId: body.commandId, marketSlug: body.slug, positionId: body.positionId, action: body.action,
    side: body.side, source: automatic ? 'AUTOMATIC' : 'MANUAL', budget: body.amount,
    quantity: qty, limitPrice, createdAt: Date.now(), strategyVersion: automatic ? p.trading?.automation?.config.version : undefined,
  };
  if (!automatic && body.action === 'SELL') takeManualControl(p, body.slug);
  const result = executePaperCommand(command, accountFor(p, body.slug, body.positionId), context.executionMarket, context.depth, policyFor(p, context, automatic));
  const mark = sideBook(context.depth, body.side).bids[0]?.price ?? null;
  applyPaperExecution(p, command, result, context.market, mark);
  const order: WorkspaceOrder = {
    id: body.commandId, commandId: body.commandId, slug: body.slug, side: body.side, action: body.action,
    source: command.source, status: result.status, filledQuantity: result.filledQty, requestedQuantity: result.requestedQty,
    averagePrice: result.averagePrice, fees: result.fees, gross: result.gross, cashDelta: result.cashDelta,
    reason: result.reason, createdAt: result.at, execution: result,
    positionId: body.action === 'BUY' ? body.commandId : body.positionId,
  };
  return order;
}
/** A single D1 transaction changes both ledger and immutable command journal, guarded by profile version. */
export async function commitOrder(p: StoredProfile, body: OrderRequest, order: WorkspaceOrder) {
  const fingerprint = requestFingerprint(body), id = `${p.id}:${body.commandId}`;
  let outcome: D1Result[];
  try {
    outcome = await db().batch([
      db().prepare('INSERT INTO trading_commands(id,user_id,command_id,fingerprint,value,created_at) SELECT ?,?,?,?,?,? FROM profiles WHERE id=? AND version=?')
        .bind(id,p.id,body.commandId,fingerprint,JSON.stringify(order),order.createdAt,p.id,p.version),
      db().prepare('UPDATE profiles SET value=?,version=version+1 WHERE id=? AND version=? AND EXISTS (SELECT 1 FROM trading_commands WHERE id=?)')
        .bind(JSON.stringify(p.data),p.id,p.version,id),
    ]);
  } catch (e) {
    const existing = await priorOrder(p.id, body.commandId, fingerprint);
    if (existing) return existing;
    throw e;
  }
  if (!outcome[0].meta.changes || !outcome[1].meta.changes) {
    const existing = await priorOrder(p.id, body.commandId, fingerprint);
    if (existing) return existing;
    throw new Error('Account changed while checking the quote. No order was applied; refresh and try again.');
  }
  return order;
}
export async function placePaperOrder(req: Request, body: OrderRequest) {
  let p = await profile(req);
  const prior = await priorOrder(p.id, body.commandId, requestFingerprint(body));
  if (prior) return {profile: p.data, order: prior};
  // Persist manual takeover before quote I/O, including when the quote fails or the sell fills zero.
  if (body.action === 'SELL' && p.data.trading?.automation?.slug === body.slug) {
    takeManualControl(p.data, body.slug);
    const {saveProfile} = await import('./storage'); await saveProfile(p); p = await profile(req);
  }
  const context = await loadExecutionContext(body.slug, p.data);
  const order = calculateOrder(p.data, body, context);
  const committed = await commitOrder(p, body, order);
  return {profile: (await profile(req)).data, order: committed};
}
export async function recordTradingObservation(slug: string, depth: Book, source: string, time = Date.now()) {
  const bid = depth.bids[0]?.price ?? null, ask = depth.asks[0]?.price ?? null;
  const price = bid !== null && ask !== null ? Math.round((bid+ask)/2*1e6)/1e6 : null;
  await db().prepare('INSERT OR IGNORE INTO trading_observations(id,slug,time,price,bid,ask,depth,source) VALUES(?,?,?,?,?,?,?,?)')
    .bind(`${slug}:${Math.floor(time/5000)}`,slug,time,price,bid,ask,[...depth.bids,...depth.asks].reduce((s,l)=>s+l.quantity,0),source).run();
  return {time, price};
}
