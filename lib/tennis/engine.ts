import { executePaperCommand, executionDataIssue } from '../trading/execution.ts';
import { feeUnits, fromUnits, notionalUnits, toUnits } from '../trading/money.ts';
import type { PaperCommand, PaperExecution, TradeSide } from '../trading/types';
import type { TennisAction, TennisConfig, TennisDecision, TennisInput, TennisIntent, TennisPosition, TennisSession, TennisSignal } from './types';

const exact = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const EPSILON = 0.0000001;
const freshLive = (input:TennisInput,now:number) => input.market.live && input.market.active && !input.market.ended && Number.isFinite(input.market.observedAt) && input.market.observedAt<=now && now-input.market.observedAt<=45_000;
const keyFor = (slug: string, side: TradeSide) => `${slug}:${side}`;

import {defaultTennisConfig, normalizeTennisConfig, validateTennisConfig} from './rules.ts';
export {defaultTennisConfig,validateTennisConfig} from './rules.ts';

export function createTennisSession(config: TennisConfig = defaultTennisConfig(), now = Date.now()): TennisSession {
  const issue = validateTennisConfig(config);
  if (issue) throw new RangeError(issue);
  if (!Number.isFinite(now) || now < 0) throw new RangeError('Invalid session time.');
  return {
    id: `tennis-${now}-${Math.random().toString(36).slice(2, 10)}`, revision: 0, rulesRevision: 0, coverage: {}, mode: 'paper', status: 'idle',
    config: structuredClone(config), cash: config.startingCash, startedAt: now, lastTickAt: now,
    lastReason: 'Ready to test price recovery with fake money. No outcome forecast is used.',
    positions: [], pending: null, histories: {}, signals: {}, consumedBooks: {}, decisions: [], ledger: [],
    equity: [{ time: now, price: config.startingCash }], rejectionCounts: {}, evaluated: 0, commandIds: [],
  };
}

/** Conservative executable equity: unavailable residual quantity has no assigned value. */
export function tennisEquity(session: TennisSession): number {
  return exact(session.cash + session.positions.filter(position => position.status === 'open')
    .reduce((sum, position) => sum + (position.netLiquidationValue ?? 0), 0));
}

function record(session: TennisSession, now: number, slug: string, side: TradeSide, action: TennisDecision['action'], code: string, reason: string, input?: TennisInput, more: Partial<TennisDecision> = {}) {
  session.lastReason = reason;
  session.decisionSequence = (session.decisionSequence ?? session.decisions.length) + 1;
  session.decisions.push({ id: `${session.id}:d:${session.decisionSequence}`, time: now, slug, side, action, code, reason, bookTime: input?.receivedAt, rulesRevision: session.rulesRevision ?? 0, ...more });
  session.decisions = session.decisions.slice(-300);
  if (action === 'SKIP') session.rejectionCounts[code] = (session.rejectionCounts[code] ?? 0) + 1;
}

function quotes(input: TennisInput, side: TradeSide) {
  const convert = (levels: TennisInput['book']['bids']) => levels.map(level => ({
    price: exact(side === 'YES' ? level.price : 1 - level.price), quantity: level.quantity,
  })).filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.quantity) && level.quantity > 0);
  const bids = convert(side === 'YES' ? input.book.bids : input.book.asks).sort((a, b) => b.price - a.price);
  const asks = convert(side === 'YES' ? input.book.asks : input.book.bids).sort((a, b) => a.price - b.price);
  return { bid: bids[0]?.price, ask: asks[0]?.price, bids, asks };
}

function policy(session: TennisSession, input: TennisInput, now: number) {
  return {
    now, bookReceivedAt: input.receivedAt, bookSource: input.source, stateCertain: true,
    maxBookAgeMs: session.config.maxBookAgeMs, maxCommandAgeMs: Math.max(30_000, session.config.executionDelayMs * 3),
    maxOrderBudget: Math.min(100, session.config.startingCash * 0.25), maxMarketExposure: Math.min(100, session.config.startingCash * 0.25),
    maxTotalExposure: Math.min(100, session.config.startingCash * 0.25), automation: 'PAPER' as const,
  };
}

function dataIssue(session: TennisSession, input: TennisInput, now: number): string | null {
  if (input.market.league !== 'ATP' && input.market.league !== 'WTA') return 'Only tennis is supported in this experiment.';
  if (!input.market.execution || input.market.execution.slug !== input.market.slug || input.market.execution.league !== input.market.league) return 'Market mapping or execution rules are unavailable.';
  if (!Array.isArray(input.book.bids) || !Array.isArray(input.book.asks)) return 'Market order book is unavailable.';
  if ([...input.book.bids, ...input.book.asks].some(level => !Number.isFinite(level.price) || level.price <= 0 || level.price >= 1 || !Number.isFinite(level.quantity) || level.quantity < 0)) return 'Market order book has invalid levels.';
  return executionDataIssue(policy(session, input, now));
}

function holding(session: TennisSession) { return session.positions.find(position => position.status === 'open'); }

function simulate(session: TennisSession, input: TennisInput, command: PaperCommand, now: number): PaperExecution {
  const position = holding(session);
  const cost = position?.costBasis ?? 0;
  return executePaperCommand(command, { cash: session.cash, marketExposure: position?.slug === input.market.slug ? cost : 0,
    totalExposure: cost, availableQuantity: position?.slug === input.market.slug && position.side === command.side ? position.quantity : 0 },
  input.market.execution!, input.book, policy(session, input, now));
}

function freshCommand(session: TennisSession, input: TennisInput, side: TradeSide, action: 'BUY' | 'SELL', now: number, limitPrice: number, source: 'MANUAL' | 'AUTOMATIC' = 'AUTOMATIC'): PaperCommand {
  return { commandId: `estimate:${session.id}:${now}:${side}`, marketSlug: input.market.slug, side, action, source,
    limitPrice, createdAt: now, strategyVersion: session.config.version };
}

function entryIssue(session: TennisSession, input: TennisInput, side: TradeSide, budget: number, now: number) {
  const issue = dataIssue(session, input, now);
  if (issue) return { code: 'DATA', reason: issue };
  if (!input.market.live) return { code: 'NOT_LIVE', reason: 'Waiting for the match to start. The bot only enters live matches.' };
  if (!Number.isFinite(input.market.observedAt) || input.market.observedAt > now || now - input.market.observedAt > 45_000) return { code: 'MATCH_STALE', reason: 'Live match status needs a fresh update.' };
  if (!session.config.leagues.includes(input.market.league)) return { code: 'LEAGUE', reason: 'This tour is not selected for the experiment.' };
  if (!input.market.active || !input.market.execution?.active || input.market.ended || input.book.state !== 'MARKET_STATE_OPEN') return { code: 'CLOSED', reason: 'This market is ended, suspended, or not open for a new entry.' };
  const quote = quotes(input, side);
  if (quote.bid === undefined || quote.ask === undefined || quote.bid > quote.ask) return { code: 'BOOK', reason: 'A valid two-sided book is required.' };
  if (quote.ask - quote.bid > session.config.maxSpreadPoints / 100 + EPSILON) return { code: 'SPREAD', reason: 'The gap between buying and selling prices is too wide.' };
  if (!Number.isFinite(budget) || budget <= 0 || budget > Math.min(session.config.startingCash * 0.25, 100) + EPSILON || budget > session.cash || exact(budget) !== budget) return { code: 'BUDGET', reason: 'The paper amount exceeds available cash or the per-entry cap.' };
  if (holding(session)) return { code: 'POSITION', reason: 'One open position at a time. Close it before another entry.' };
  const buy = simulate(session, input, { ...freshCommand(session, input, side, 'BUY', now, quote.ask), budget }, now);
  if (buy.status !== 'filled' || !buy.apply) return { code: 'ENTRY_DEPTH', reason: `The full entry cannot execute at the quoted buying price. ${buy.reason}` };
  const sell = executePaperCommand({ ...freshCommand(session, input, side, 'SELL', now, quote.bid), quantity: buy.filledQty },
    { cash: exact(session.cash + buy.cashDelta), marketExposure: -buy.cashDelta, totalExposure: -buy.cashDelta, availableQuantity: buy.filledQty },
    input.market.execution!, input.book, policy(session, input, now));
  if (sell.status !== 'filled') return { code: 'EXIT_DEPTH', reason: 'Not enough buyers currently exist to sell the full proposed position at the quoted selling price.' };
  if (1 - sell.cashDelta / -buy.cashDelta >= session.config.stopReturn - EPSILON) return { code: 'ENTRY_COST', reason: 'Buying and selling immediately would already reach the loss limit after spread and fees.' };
  return null;
}

/** A return to the old midpoint is a scenario, not a forecast or executable quote. */
function recoveryHeadroomIssue(session: TennisSession, input: TennisInput, side: TradeSide, baseline: number, now: number): string | null {
  const quote = quotes(input, side);
  if (quote.ask === undefined || quote.bid === undefined || !input.market.execution) return 'A baseline and two-sided book are required to estimate recovery costs.';
  const buy = simulate(session, input, { ...freshCommand(session, input, side, 'BUY', now, quote.ask), budget: session.config.entryBudget }, now);
  if (buy.status !== 'filled' || !buy.apply) return 'The complete entry is unavailable for cost estimation.';
  const rules = input.market.execution;
  const futureBid = exact(Math.floor((baseline - (quote.ask - quote.bid) / 2 + EPSILON) / rules.priceIncrement) * rules.priceIncrement);
  if (futureBid <= 0 || futureBid >= 1) return 'The prior midpoint does not imply a usable hypothetical exit price.';
  try {
    const size = toUnits(buy.filledQty);
    const price = toUnits(futureBid);
    const netProceeds = fromUnits(notionalUnits(size, price) - feeUnits(size, price, toUnits(rules.feeCoefficient)));
    if (netProceeds / -buy.cashDelta - 1 < session.config.targetReturn - EPSILON) {
      return 'Even a return to the prior midpoint, allowing for the current spread and estimated entry/exit fees, would not cover the configured net profit target.';
    }
  } catch {
    return 'Execution rules are invalid for a fee-aware recovery estimate.';
  }
  return null;
}

function stage(session: TennisSession, input: TennisInput, side: TradeSide, action: 'BUY' | 'SELL', now: number, source: 'MANUAL' | 'AUTOMATIC', reason: string, budget?: number, id?: string) {
  const quote = quotes(input, side);
  const limitPrice = action === 'BUY' ? quote.ask : quote.bid;
  if (limitPrice === undefined) {
    record(session, now, input.market.slug, side, 'SKIP', 'NO_BUYERS', 'No executable buyers are currently available. The position remains open.', input);
    return;
  }
  if (action === 'SELL' && holding(session)) session.exitRequested = { positionId: holding(session)!.id, reason, source };
  session.pending = {
    id: id ?? `${session.id}:order:${session.revision}:${now}`, market: structuredClone(input.market), slug: input.market.slug, side, action,
    positionId: action === 'SELL' ? holding(session)?.id : undefined, budget,
    limitPrice, createdAt: now, executeAfter: now + session.config.executionDelayMs, observedAt: input.receivedAt, source, reason,
  };
  record(session, now, input.market.slug, side, 'SIGNAL', action === 'BUY' ? 'ENTRY_PENDING' : 'EXIT_PENDING',
    `${reason} Waiting at least ${session.config.executionDelayMs / 1000}s and for a later fresh book before simulating a fill.`, input);
}

function markPosition(session: TennisSession, position: TennisPosition, input: TennisInput | undefined, now: number) {
  position.netLiquidationValue = null;
  position.liquidationQuantity = 0;
  position.markedAt = null;
  if (!input || dataIssue(session, input, now)) return;
  const quote = quotes(input, position.side);
  if (quote.bid === undefined) return;
  // All displayed bids contribute to a conservative full-book liquidation estimate.
  const lowestBid = quote.bids.at(-1)!.price;
  const result = simulate(session, input, { ...freshCommand(session, input, position.side, 'SELL', now, lowestBid, 'MANUAL'), quantity: position.quantity }, now);
  if (!result.apply) return;
  position.netLiquidationValue = result.cashDelta;
  position.liquidationQuantity = result.filledQty;
  position.markedAt = input.receivedAt;
}

function settle(session: TennisSession, position: TennisPosition, input: TennisInput | undefined, now: number): boolean {
  if (!input || (input.source !== 'REST' && input.source !== 'WEBSOCKET') || typeof input.settlement !== 'number' || !Number.isFinite(input.settlement) || input.settlement < 0 || input.settlement > 1 ||
      !Number.isFinite(input.settlementReceivedAt) || input.settlementReceivedAt! > now || input.settlementReceivedAt! < position.openedAt) return false;
  const price = position.side === 'YES' ? input.settlement : 1 - input.settlement;
  const proceeds = exact(position.quantity * price);
  const pnl = exact(proceeds - position.costBasis);
  session.cash = exact(session.cash + proceeds);
  position.realizedPnl = exact(position.realizedPnl + pnl);
  position.proceeds = exact(position.proceeds + proceeds);
  position.quantity = 0; position.costBasis = 0; position.status = 'settled'; position.closedAt = now;
  position.exitPrice = price; position.netLiquidationValue = 0; position.liquidationQuantity = 0; position.markedAt = input.settlementReceivedAt!;
  session.pending = null; session.exitRequested = undefined;
  session.ledger.push({ id: `${position.id}:settlement`, time: now, slug: position.slug, side: position.side, action: 'SETTLE', source: 'AUTOMATIC', positionId: position.id,
    reason: 'Resolved using an explicit final market settlement value.', cashDelta: proceeds, realizedPnl: pnl, rulesRevision:session.rulesRevision??0,strategy:session.config.strategy });
  record(session, now, position.slug, position.side, 'SETTLE', 'SETTLED', 'Final market settlement applied to remaining paper quantity.', input);
  setCooldown(session, position.slug, now);
  return true;
}

function setCooldown(session: TennisSession, slug: string, now: number) {
  for (const side of ['YES', 'NO'] as const) {
    session.signals[keyFor(slug, side)] = { phase: 'COOLDOWN', confirmations: 0, cooldownUntil: now + session.config.cooldownMs,
      lastObservedAt: session.consumedBooks[slug], reason: 'Waiting after an entry/exit attempt before looking for another dip.' };
  }
}

function applyFill(session: TennisSession, intent: TennisIntent, result: PaperExecution, input: TennisInput, now: number) {
  const oldPosition = holding(session);
  const positionId = intent.action === 'BUY' ? intent.id : oldPosition!.id;
  let pnl = 0;
  if (result.apply && result.filledQty > 0) {
    session.cash = exact(session.cash + result.cashDelta);
    if (intent.action === 'BUY') {
      session.positions.push({ id: positionId, slug: intent.slug, league: input.market.league, title: input.market.title, side: intent.side,
        name: intent.side === 'YES' ? input.market.yesName : input.market.noName, quantity: result.filledQty, initialQuantity: result.filledQty,
        costBasis: -result.cashDelta, entryCost: -result.cashDelta, entryPrice: result.averagePrice, entryFees: result.fees, openedAt: now,
        status: 'open', realizedPnl: 0, exitFees: 0, proceeds: 0, netLiquidationValue: null, liquidationQuantity: 0, markedAt: null,
        market: structuredClone(input.market) });
    } else if (oldPosition) {
      const full = Math.abs(result.filledQty - oldPosition.quantity) < EPSILON;
      const allocated = full ? oldPosition.costBasis : exact(oldPosition.costBasis * result.filledQty / oldPosition.quantity);
      pnl = exact(result.cashDelta - allocated);
      oldPosition.quantity = full ? 0 : exact(oldPosition.quantity - result.filledQty);
      oldPosition.costBasis = full ? 0 : exact(oldPosition.costBasis - allocated);
      oldPosition.realizedPnl = exact(oldPosition.realizedPnl + pnl);
      oldPosition.proceeds = exact(oldPosition.proceeds + result.cashDelta);
      oldPosition.exitFees = exact(oldPosition.exitFees + result.fees);
      oldPosition.exitPrice = exact((oldPosition.proceeds + oldPosition.exitFees) / (oldPosition.initialQuantity - oldPosition.quantity));
      oldPosition.netLiquidationValue = null; oldPosition.liquidationQuantity = 0; oldPosition.markedAt = null;
      if (full) { oldPosition.status = 'closed'; oldPosition.closedAt = now; session.exitRequested = undefined; setCooldown(session, oldPosition.slug, now); }
    }
  }
  session.ledger.push({ id: intent.id, time: now, slug: intent.slug, side: intent.side, action: intent.action,
    source: intent.source, positionId, reason: intent.reason, execution: result, rulesRevision:session.rulesRevision??0,strategy:session.config.strategy,
    cashDelta: result.cashDelta, realizedPnl: pnl, quotedPrice: intent.limitPrice, actualPrice: result.averagePrice || undefined,
    executionDelayMs: now - intent.createdAt, signalBookTime: intent.observedAt, executionBookTime: input.receivedAt });
  record(session, now, intent.slug, intent.side, result.apply ? intent.action : 'SKIP', result.apply ? result.status.toUpperCase() : 'FILL_FAILED',
    `${intent.reason} ${result.reason}`, input);
  if (!result.apply && intent.action === 'BUY') setCooldown(session, intent.slug, now);
  // Paper exits are IOC: unfilled quantity stays in the position and is retried on later data.
  if (intent.action === 'SELL' && holding(session)) {
    session.lastReason = `Exit ${result.status}; ${holding(session)!.quantity} contracts remain. Waiting for a later book to retry.`;
  }
}

function processPending(session: TennisSession, inputs: TennisInput[], now: number): boolean {
  const intent = session.pending;
  if (!intent) return false;
  if (intent.action === 'BUY' && intent.source !== 'AUTOMATIC') {
    session.pending = null;
    record(session, now, intent.slug, intent.side, 'SKIP', 'RETIRED_ENTRY', 'An earlier user-placed entry was canceled. Only the bot can open a position.');
    return false;
  }
  if (intent.action === 'BUY' && (session.status === 'stopped' || session.status === 'stopping' || (intent.source === 'AUTOMATIC' && session.status !== 'running'))) {
    session.pending = null;
    record(session, now, intent.slug, intent.side, 'SKIP', 'CANCELLED', 'Pending entry canceled because the experiment is paused or stopped.');
    return false;
  }
  if (now < intent.executeAfter) { session.lastReason = 'Paper execution delay is still running.'; return true; }
  if (now - intent.createdAt > Math.max(30_000, session.config.executionDelayMs * 3)) {
    session.pending = null;
    record(session, now, intent.slug, intent.side, 'SKIP', 'INTENT_EXPIRED', 'The paper order expired before a usable later book arrived.');
    return false;
  }
  const input = inputs.find(item => item.market.slug === intent.slug);
  if (!input || dataIssue(session, input, now) || input.receivedAt <= intent.observedAt || input.receivedAt < intent.executeAfter || input.receivedAt <= (session.consumedBooks[intent.slug] ?? -1)) {
    session.lastReason = 'Waiting for a new authoritative book after the execution delay; cached quotes cannot fill an order.';
    return true;
  }
  if (session.ledger.some(entry => entry.id === intent.id)) { session.pending = null; return false; }
  if (intent.action === 'BUY') {
    const issue = entryIssue(session, input, intent.side, intent.budget ?? 0, now) ?? pendingSignalIssue(session, input, intent, now);
    // Recheck the complete entry and its exit costs on the later book.
    if (issue) {
      session.pending = null;
      session.consumedBooks[intent.slug] = input.receivedAt;
      record(session, now, intent.slug, intent.side, 'SKIP', issue.code, `Pending entry canceled: ${issue.reason}`, input);
      return false;
    }
  }
  const position = holding(session);
  if (intent.action === 'SELL' && (!position || position.id !== intent.positionId || position.slug !== intent.slug)) {
    session.pending = null; return false;
  }
  const command: PaperCommand = { commandId: intent.id, marketSlug: intent.slug, positionId: intent.positionId,
    side: intent.side, action: intent.action, source: intent.source, limitPrice: intent.limitPrice,
    createdAt: intent.createdAt, strategyVersion: session.config.version,
    ...(intent.action === 'BUY' ? { budget: intent.budget } : { quantity: position!.quantity }) };
  const result = simulate(session, input, command, now);
  session.consumedBooks[intent.slug] = input.receivedAt;
  session.pending = null;
  applyFill(session, intent, result, input, now);
  return true;
}

function beginObservation(session:TennisSession,duration:number|undefined,now:number) {
  if(duration===undefined)return;
  if(!Number.isFinite(duration)||duration<60_000||duration>3_600_000)return;
  session.testRun={startedAt:now,endsAt:now+duration,watchedMs:0,lastCheckAt:now,startingCash:session.cash,
    startingLedgerCount:session.ledger.length,liveSlugs:[],complete:false};
}

function pendingSignalIssue(session:TennisSession,input:TennisInput,intent:TennisIntent,now:number) {
  const signal=session.signals[keyFor(intent.slug,intent.side)],quote=quotes(input,intent.side);
  const price=quote.bid!==undefined&&quote.ask!==undefined?(quote.bid+quote.ask)/2:NaN;
  if(!signal||signal.lastPrice===undefined||signal.lastBid===undefined||signal.baseline===undefined||
    price<signal.lastPrice-EPSILON||quote.bid!<signal.lastBid-EPSILON)
    return {code:'SIGNAL_CHANGED',reason:'The confirmed price or buyers weakened during the execution delay.'};
  if(session.config.strategy==='recovery') {
    if(signal.dipAt===undefined||now-signal.dipAt>session.config.baselineWindowMs||price>=signal.baseline||
      signal.trough===undefined||signal.troughBid===undefined||price-signal.trough<session.config.recoveryPoints/100-EPSILON||
      quote.bid!-signal.troughBid<session.config.recoveryPoints/100-EPSILON)
      return {code:'SIGNAL_CHANGED',reason:'The recovery expired or no longer meets your entry rules.'};
    const issue=recoveryHeadroomIssue(session,input,intent.side,signal.baseline,now);
    if(issue)return {code:'COST_HEADROOM',reason:issue};
  } else if(signal.dipAt===undefined||now-signal.dipAt>session.config.baselineWindowMs||price-signal.baseline<session.config.momentumPoints/100-EPSILON||signal.baselineBid===undefined||
    quote.bid!-signal.baselineBid<session.config.momentumPoints/100-EPSILON) {
    return {code:'SIGNAL_CHANGED',reason:'The rise is no longer confirmed by current buyers.'};
  }
  return null;
}

function updateMomentum(session:TennisSession,input:TennisInput,side:TradeSide,state:TennisSignal,
  history:TennisSession['histories'][string],oldPrice:number|undefined,oldBid:number|undefined,now:number,
  wait:(code:string,reason:string,skip?:boolean)=>void) {
  const quote=quotes(input,side),price=state.lastPrice!;
  const median=(values:number[])=>{const sorted=values.sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;};
  if(state.phase==='RISING' && (state.dipAt===undefined || input.receivedAt-state.dipAt>session.config.baselineWindowMs)) {state.phase='WATCHING';state.confirmations=0;}
  if(state.phase!=='RISING') {
    state.dipAt=input.receivedAt;
    state.baseline=median(history.slice(0,-1).map(p=>p.price));
    const bids=history.slice(0,-1).map(p=>p.bid).filter((b):b is number=>b!==undefined);
    if(bids.length<session.config.minSamples-1)return wait('WARMUP','Collecting buyer history for the rise strategy.');
    state.baselineBid=median(bids);
  }
  if(price-state.baseline!<session.config.momentumPoints/100-EPSILON||quote.bid!-state.baselineBid!<session.config.momentumPoints/100-EPSILON||
    oldPrice!==undefined&&price<oldPrice-EPSILON||oldBid!==undefined&&quote.bid!<oldBid-EPSILON) {
    state.phase='WATCHING';state.confirmations=0;
    return wait('NO_MOMENTUM','Waiting for both the price and buyers to show a sustained rise.');
  }
  state.phase='RISING';state.confirmations++;
  if(state.confirmations<session.config.momentumConfirmations)return wait('CONFIRMATION','A rise appeared. Waiting for another independent buyer confirmation.');
  if(session.pending||holding(session))return wait('POSITION','The bot is already managing a position or pending entry.',true);
  const issue=entryIssue(session,input,side,session.config.entryBudget,now);
  if(issue)return wait(issue.code,issue.reason,true);
  const buy=simulate(session,input,{...freshCommand(session,input,side,'BUY',now,quote.ask!),budget:session.config.entryBudget},now);
  if(buy.filledQty/-buy.cashDelta-1<session.config.targetReturn-EPSILON)return wait('COST_HEADROOM','Even the maximum contract payout cannot reach this profit target after entry costs.',true);
  stage(session,input,side,'BUY',now,'AUTOMATIC','Price and executable buyers rose above their recent baselines; experimental momentum signal.',session.config.entryBudget);
}

function updateSignal(session: TennisSession, input: TennisInput, side: TradeSide, now: number) {
  const key = keyFor(input.market.slug, side);
  const quote = quotes(input, side);
  const previous: TennisSignal = session.signals[key] ?? { phase: 'WARMING', confirmations: 0, reason: 'Building a fresh rolling baseline.' };
  if (input.receivedAt <= (previous.lastObservedAt ?? -1)) return;
  if (quote.bid === undefined || quote.ask === undefined || quote.bid > quote.ask) {
    record(session, now, input.market.slug, side, 'SKIP', 'BOOK', 'Waiting for consistent buyer and seller prices.', input); return;
  }
  const price = exact((quote.bid + quote.ask) / 2);
  const oldPrice = previous.lastPrice;
  const oldBid = previous.lastBid;
  const state: TennisSignal = { ...previous, lastObservedAt: input.receivedAt, lastPrice: price, lastBid: quote.bid };
  session.signals[key] = state;
  const history = (session.histories[key] ?? []).filter(point => point.time >= input.receivedAt - session.config.baselineWindowMs && point.time < input.receivedAt);
  history.push({ time: input.receivedAt, price, bid: quote.bid, ask:quote.ask, score:input.market.score, period:input.market.period, scoreUpdatedAt:input.market.contextUpdatedAt });
  session.histories[key] = history.slice(-600);
  session.evaluated++;
  const wait = (code: string, reason: string, skip = false) => { state.reason = reason; record(session, now, input.market.slug, side, skip ? 'SKIP' : 'WAIT', code, reason, input, { baseline: state.baseline, price }); };
  if (state.cooldownUntil && now < state.cooldownUntil) { state.phase = 'COOLDOWN'; return wait('COOLDOWN', 'Waiting for this match’s post-trade cooldown.'); }
  if (state.phase === 'COOLDOWN') { state.phase = 'WARMING'; state.confirmations = 0; state.trough = undefined; state.dipAt = undefined; }
  if (history.length < session.config.minSamples || input.receivedAt - history[0].time < session.config.minimumHistoryMs) { state.phase = 'WARMING'; return wait('WARMUP', `Collecting fresh quotes (${history.length}/${session.config.minSamples}; need ${Math.round(session.config.minimumHistoryMs / 1000)}s of history).`); }
  if (session.config.strategy === 'momentum') return updateMomentum(session, input, side, state, history, oldPrice, oldBid, now, wait);
  if (state.phase === 'WARMING' || state.phase === 'WATCHING') {
    const values = history.slice(0, -1).map(point => point.price).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const baseline = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    state.baseline = baseline;
    if (baseline - price < session.config.declinePoints / 100 - EPSILON) { state.phase = 'WATCHING'; return wait('NO_DIP', 'No qualifying drop from this outcome’s recent median price.'); }
    state.phase = 'DIP'; state.trough = price; state.troughBid = quote.bid; state.dipAt = input.receivedAt; state.confirmations = 0;
    return wait('DIP', 'A drop was observed. Waiting for buyers and price to recover on later quotes.');
  }
  if (state.trough === undefined || state.baseline === undefined || state.dipAt === undefined || state.troughBid === undefined) {
    state.phase = 'WARMING'; state.confirmations = 0; return wait('RESET', 'Rebuilding an incomplete candidate.');
  }
  if (input.receivedAt - state.dipAt > session.config.baselineWindowMs || price >= state.baseline) {
    state.phase = 'WATCHING'; state.confirmations = 0; state.dipAt = undefined;
    return wait('EXPIRED', 'The setup expired or fully recovered before an entry.');
  }
  if (price < state.trough - EPSILON || quote.bid < state.troughBid - EPSILON) {
    state.trough = Math.min(price, state.trough); state.troughBid = Math.min(quote.bid, state.troughBid);
    state.phase = 'DIP'; state.confirmations = 0;
    return wait('FALLING', 'Price or executable buyers are still falling. No entry.');
  }
  if (price - state.trough < session.config.recoveryPoints / 100 - EPSILON || quote.bid - state.troughBid < session.config.recoveryPoints / 100 - EPSILON || (oldPrice !== undefined && price < oldPrice - EPSILON) || (oldBid !== undefined && quote.bid < oldBid - EPSILON)) {
    state.phase = 'DIP'; state.confirmations = 0;
    return wait('NO_RECOVERY', 'The recovery is not confirmed by executable buyers.');
  }
  state.phase = 'RECOVERING'; state.confirmations++;
  if (state.confirmations < session.config.recoveryConfirmations) return wait('CONFIRMATION', 'Waiting for another independent recovery quote.');
  if (session.pending || holding(session)) return wait('POSITION', 'Another paper position or delayed order owns the one-position slot.', true);
  const issue = entryIssue(session, input, side, session.config.entryBudget, now);
  if (issue) return wait(issue.code, issue.reason, true);
  const headroom = recoveryHeadroomIssue(session, input, side, state.baseline, now);
  if (headroom) return wait('COST_HEADROOM', headroom, true);
  stage(session, input, side, 'BUY', now, 'AUTOMATIC', 'Temporary price drop followed by confirmed buyer recovery; experimental price-only signal.', session.config.entryBudget);
}

/** Pure reducer. Callers persist the complete returned state with one account revision/CAS. */
export function stepTennisSession(previous: TennisSession, inputs: TennisInput[], now: number): TennisSession {
  if (!Number.isFinite(now) || now < previous.lastTickAt) return previous;
  const session = structuredClone(previous);
  session.config = normalizeTennisConfig(session.config);
  session.revision++;
  session.lastTickAt = now;
  const configIssue = validateTennisConfig(session.config);
  if (configIssue) { session.status = 'paused'; session.pending = null; session.lastReason = configIssue; return session; }
  const sorted = inputs.filter(input => input && input.market && input.book).sort((a, b) => b.receivedAt - a.receivedAt);
  const current = [...new Map(sorted.map(input => [input.market.slug, input] as const).reverse()).values()];
  session.coverage ??= {};
  session.quotes ??= {};
  for (const input of current) if (!dataIssue(session, input, now)) {
    session.coverage[input.market.slug] = {league: input.market.league, time: input.receivedAt, live: freshLive(input,now)};
    session.quotes[input.market.slug] = {time:input.receivedAt,bid:input.book.bids[0]?.price??null,ask:input.book.asks[0]?.price??null,source:input.source};
  }
  if (session.testRun && !session.testRun.complete) {
    const run = session.testRun;
    if (session.status === 'running' && current.some(i=>freshLive(i,now)&&!dataIssue(session,i,now))) run.watchedMs += Math.min(10_000, Math.max(0, Math.min(now, run.endsAt) - run.lastCheckAt));
    run.lastCheckAt = now;
    run.liveSlugs = [...new Set([...run.liveSlugs, ...current.filter(i => freshLive(i,now) && !dataIssue(session, i, now)).map(i => i.market.slug)])];
    if (now >= run.endsAt) {
      run.complete = true;
      if (session.status === 'running') session.status = 'paused';
      if (session.pending?.action === 'BUY') session.pending = null;
      record(session, now, '', 'YES', 'WAIT', 'RUN_COMPLETE', 'The observation window finished. New entries paused; existing exits remain managed.');
    }
  }
  const open = holding(session);
  if (open) settle(session, open, current.find(input => input.market.slug === open.slug), now);
  const processed = processPending(session, current, now);
  const position = holding(session);
  if (position) {
    const input = current.find(item => item.market.slug === position.slug);
    markPosition(session, position, input, now);
    const realised = session.positions.reduce((sum, item) => sum + item.realizedPnl, 0);
    const completeMark = position.netLiquidationValue !== null && position.liquidationQuantity >= position.quantity - EPSILON;
    const breached = realised <= -session.config.startingCash * session.config.maxSessionLossFraction || (completeMark && tennisEquity(session) <= session.config.startingCash * (1 - session.config.maxSessionLossFraction));
    if (breached) { session.status = 'stopping'; if (session.pending?.action === 'BUY') session.pending = null; }
    if (!session.pending && input && !dataIssue(session, input, now) && input.receivedAt > (session.consumedBooks[position.slug] ?? -1)) {
      const availableReturn = position.netLiquidationValue !== null && position.liquidationQuantity > 0
        ? position.netLiquidationValue / (position.costBasis * position.liquidationQuantity / position.quantity) - 1 : null;
      // A profit target requires buyers for the entire position. Partial books can still reduce losses.
      const reason = session.exitRequested?.positionId === position.id ? session.exitRequested.reason : session.status === 'stopping' ? 'Session stopped: attempting to close remaining paper quantity.'
        : completeMark && availableReturn !== null && availableReturn >= session.config.targetReturn - EPSILON ? 'Net profit target reached after estimated exit fees.'
          : availableReturn !== null && availableReturn <= -session.config.stopReturn + EPSILON ? 'Net loss threshold reached; attempting a price-bounded exit.'
            : now - position.openedAt >= session.config.maxHoldMs ? 'Maximum holding time reached.' : null;
      if (reason) stage(session, input, position.side, 'SELL', now, session.exitRequested?.source ?? 'AUTOMATIC', reason);
      else if (!processed) record(session, now, position.slug, position.side, 'WAIT', availableReturn === null ? 'NO_EXIT_DEPTH' : 'HOLDING',
        availableReturn === null ? 'No executable exit price is currently available. The position remains open.' : 'Holding until net profit, loss, or time exit rules trigger.', input, { netReturn: availableReturn ?? undefined });
    }
  } else {
    const realised = session.positions.reduce((sum, item) => sum + item.realizedPnl, 0);
    if (realised <= -session.config.startingCash * session.config.maxSessionLossFraction) session.status = 'stopped';
    if (session.status === 'stopping') session.status = 'stopped';
  }
  if (session.status === 'running' && !holding(session) && !session.pending && !processed) {
    for (const input of current.sort((a, b) => a.market.slug.localeCompare(b.market.slug))) {
      const issue = dataIssue(session, input, now);
      if (issue) { record(session, now, input.market.slug, 'YES', 'SKIP', 'DATA', issue, input); continue; }
      if (!session.config.leagues.includes(input.market.league) || input.market.ended || !input.market.active || input.book.state !== 'MARKET_STATE_OPEN') {
        record(session, now, input.market.slug, 'YES', 'SKIP', 'CLOSED', 'Tour not selected or match market is not open.', input); continue;
      }
      if (!input.market.live || now - input.market.observedAt > 45_000 || input.market.observedAt > now) {
        record(session, now, input.market.slug, 'YES', 'SKIP', input.market.live ? 'MATCH_STALE' : 'NOT_LIVE', input.market.live ? 'Waiting for fresh live match status.' : 'Waiting for the match to start. Live matches only.', input); continue;
      }
      if (input.receivedAt <= (session.consumedBooks[input.market.slug] ?? -1)) continue;
      for (const side of ['YES', 'NO'] as const) {
        updateSignal(session, input, side, now);
        if (session.pending) break;
      }
      if (session.pending) break;
    }
  }
  const value = tennisEquity(session);
  if (!session.equity.length || session.equity.at(-1)!.price !== value || now - session.equity.at(-1)!.time >= 10_000) session.equity.push({ time: now, price: value });
  session.equity = session.equity.slice(-2000);
  return session;
}

export function applyTennisAction(previous: TennisSession, action: TennisAction, inputs: TennisInput[], now: number): TennisSession {
  if (!Number.isFinite(now) || now < previous.lastTickAt) return previous;
  if ('sessionId' in action && action.sessionId && action.sessionId !== previous.id) return previous;
  if (action.commandId && previous.commandIds.includes(action.commandId)) return previous;
  if (action.action === 'tick') return stepTennisSession(previous, inputs, now);
  let session = structuredClone(previous);
  session.config = normalizeTennisConfig(session.config);
  session.revision++;
  session.lastTickAt = now;
  if (action.commandId) session.commandIds.push(action.commandId);
  const reject = (reason: string) => { session.lastReason = reason; return session; };
  if (action.action === 'update-rules') {
    if (action.expectedRulesRevision !== (session.rulesRevision ?? 0)) return reject('Bot rules changed in another tab. Reopen Bot rules and try again.');
    const config = {...session.config, ...action.rules};
    const issue = validateTennisConfig(config);
    if (issue) return reject(issue);
    if (config.startingCash !== session.config.startingCash || config.version !== session.config.version) return reject('Balance and internal version cannot be changed through bot rules.');
    if (session.pending?.action === 'BUY') {
      record(session, now, session.pending.slug, session.pending.side, 'SKIP', 'RULES_CANCELLED', 'Pending entry canceled because the bot rules changed.');
      session.pending = null;
    }
    session.config = structuredClone(config);
    session.rulesRevision = (session.rulesRevision ?? 0) + 1;
    session.histories = {}; session.signals = {};
    record(session, now, '', 'YES', 'WAIT', 'RULES_UPDATED', `Bot rules saved (revision ${session.rulesRevision}). Gathering a new baseline; balance and history preserved.`);
    return session;
  }
  if (action.action === 'reset') {
    if (holding(session) || session.pending) return reject('Close the paper position and let pending orders finish before resetting.');
    if (!Number.isFinite(action.bankroll) || action.bankroll < 5 || action.bankroll > 1000) return reject('Choose a fake starting balance between $5 and $1,000.');
    session = createTennisSession(defaultTennisConfig(action.bankroll), now);
    session.commandIds = [action.commandId];
    return session;
  }
  if (action.action === 'start') {
    if (holding(session) || session.pending || session.status !== 'idle') return reject('This session already exists. Resume it, or reset an empty session to begin a new balance.');
    const config = { ...session.config, ...action.config, version: 'tennis-recovery-v1' as const };
    const issue = validateTennisConfig(config);
    if (issue) return reject(issue);
    session.config = structuredClone(config); session.cash = config.startingCash; session.startedAt = now;
    session.equity = [{ time: now, price: config.startingCash }];
    session.status = 'running'; session.lastReason = 'Paper bot started. Gathering fresh live-match quotes.';
    beginObservation(session, action.runForMs, now);
    return stepTennisSession(session, inputs, now);
  }
  if (action.action === 'pause') {
    if (session.status === 'stopped' || session.status === 'stopping') return reject('This session is stopping or stopped; pause cannot restart it.');
    session.status = 'paused';
    if (session.pending?.action === 'BUY') session.pending = null;
    session.lastReason = 'New entries paused. Existing paper positions still receive exit checks while the page is running.';
    return session;
  }
  if (action.action === 'resume') {
    const realized = session.positions.reduce((sum, item) => sum + item.realizedPnl, 0);
    if (session.status === 'stopped' || session.status === 'stopping' || realized <= -session.config.startingCash * session.config.maxSessionLossFraction) return reject('This session is stopped. Close remaining positions and reset to start another experiment.');
    session.status = 'running'; session.lastReason = 'Paper bot resumed with your saved rules.';
    beginObservation(session, action.runForMs, now);
    return stepTennisSession(session, inputs, now);
  }
  if (action.action === 'stop') {
    if (session.pending?.action === 'BUY') session.pending = null;
    session.status = holding(session) ? 'stopping' : 'stopped';
    session.lastReason = holding(session) ? 'Stopped new entries. Attempting to close the existing paper position on fresh buyer quotes.' : 'Paper experiment stopped.';
    return stepTennisSession(session, inputs, now);
  }
  return reject('Only bot controls are supported.');
}
