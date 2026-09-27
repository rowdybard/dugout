import { executePaperCommand, executionDataIssue } from '../trading/execution.ts';
import { feeUnits, fromUnits, notionalUnits, toUnits } from '../trading/money.ts';
import type { PaperCommand, PaperExecution, TradeSide } from '../trading/types';
import type { TennisAction, TennisConfig, TennisDecision, TennisInput, TennisIntent, TennisPosition, TennisSession, TennisSignal } from './types';

const exact = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const EPSILON = 0.0000001;
const freshLive = (input:TennisInput,now:number) => input.market.live && input.market.active && !input.market.ended && Number.isFinite(input.market.observedAt) && input.market.observedAt<=now && now-input.market.observedAt<=45_000;
const keyFor = (slug: string, side: TradeSide) => `${slug}:${side}`;

import {defaultTennisConfig,defaultLiveTennisConfig, normalizeTennisConfig, validateTennisConfig} from './rules.ts';
import {analyzeOpportunity,type OpportunityAnalysis} from './opportunity.ts';
import {createExitPlan,assessAdaptiveExit,measureExitMarket,type AdaptiveExitAssessment} from './exit-analysis.ts';
import {adaptiveTennisRules} from './auto.ts';
import {quoteAvailabilityIssue} from './quote-status.ts';
import {currentTennisContext} from './market-context.ts';
import {bookOrderIssue} from './book-order.ts';
import {assessFootballContext,footballBoundaryChanged,isFootballMarket,normalizePositionExitRules} from './football-context.ts';
import {advanceShadowExits} from './shadow-exits.ts';
export {defaultTennisConfig,validateTennisConfig} from './rules.ts';

export function createTennisSession(config: TennisConfig = defaultTennisConfig(), now = Date.now()): TennisSession {
  const issue = validateTennisConfig(config);
  if (issue) throw new RangeError(issue);
  if (!Number.isFinite(now) || now < 0) throw new RangeError('Invalid session time.');
  return {
    id: `tennis-${now}-${Math.random().toString(36).slice(2, 10)}`, revision: 0, rulesRevision: 0, coverage: {}, mode: 'paper', status: 'idle',
    config: structuredClone(config), cash: config.startingCash, startedAt: now, lastTickAt: now,
    lastReason: config.decisionEngine==='local-move-v1'?'Ready for local move analysis with fake money. Waiting for an explicit Start.':'Ready to test price recovery with fake money. No outcome forecast is used.',
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
  session.decisions.push({ id: `${session.id}:d:${session.decisionSequence}`, time: now, slug, side, action, code, reason, bookTime: input?.receivedAt, rulesRevision: session.rulesRevision ?? 0,
    ...(input&&isFootballMarket(input.market)?{context:session.footballReports?.[slug]?.assessment}:{}),...more });
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
  const delay=holding(session)?.exitPlan?.executionDelayMs??session.config.executionDelayMs;
  return {
    now, bookReceivedAt: input.receivedAt, bookSource: input.source, stateCertain: true,
    maxBookAgeMs: session.config.maxBookAgeMs, maxCommandAgeMs: Math.max(30_000, delay * 3),
    maxOrderBudget: Math.min(100, session.config.startingCash * 0.25), maxMarketExposure: Math.min(100, session.config.startingCash * 0.25),
    maxTotalExposure: Math.min(100, session.config.startingCash * 0.25), automation: 'PAPER' as const,
  };
}

function dataIssue(session: TennisSession, input: TennisInput, now: number): string | null {
  const orderingIssue=bookOrderIssue(input,session.bookSourceTimes?.[input.market.slug],now);
  if(orderingIssue)return orderingIssue;
  if (!['ATP','WTA','NFL','CFB'].includes(input.market.league)) return 'Only tennis and American football are supported in this experiment.';
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
    limitPrice, createdAt: now, strategyVersion: (action==='SELL'?holding(session)?.entryAnalysis?.version:undefined)??session.config.decisionEngine??session.config.version };
}

function entryIssue(session: TennisSession, input: TennisInput, side: TradeSide, budget: number, now: number) {
  const issue = dataIssue(session, input, now);
  if (issue) return { code: 'DATA', reason: issue };
  if (!input.market.live) return { code: 'NOT_LIVE', reason: 'Waiting for the match to start. The bot only enters live matches.' };
  if (!Number.isFinite(input.market.observedAt) || input.market.observedAt > now || now - input.market.observedAt > 45_000) return { code: 'MATCH_STALE', reason: 'Live match status needs a fresh update.' };
  if(session.config.decisionPolicy==='football-context-v1'&&isFootballMarket(input.market)){
    const context=session.footballReports?.[input.market.slug]?.assessment;
    if(context?.status!=='fresh')return {code:`CONTEXT_${(context?.status??'unknown').toUpperCase()}`,reason:context?.reason??'Waiting for verified football context.'};
  }
  if (!session.config.leagues.includes(input.market.league)) return { code: 'LEAGUE', reason: 'This tour is not selected for the experiment.' };
  if (session.config.focusSlug && session.config.focusSlug !== input.market.slug) return {code:'FOCUS',reason:'New entries are restricted to the focused game.'};
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

function stage(session: TennisSession, input: TennisInput, side: TradeSide, action: 'BUY' | 'SELL', now: number, source: 'MANUAL' | 'AUTOMATIC', reason: string, budget?: number, id?: string, analysis?:OpportunityAnalysis,exitAnalysis?:AdaptiveExitAssessment) {
  const delay=action==='SELL'?(holding(session)?.exitPlan?.executionDelayMs??session.config.executionDelayMs):session.config.executionDelayMs;
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
    limitPrice, createdAt: now, executeAfter: now + delay, observedAt: input.receivedAt, source, reason,
    ...(action==='BUY'?{signalConfig:structuredClone(session.config),signalSnapshot:structuredClone(session.signals[keyFor(input.market.slug,side)]),decisionMode:session.config.strategy,
      ...(session.config.decisionPolicy==='football-context-v1'&&isFootballMarket(input.market)?{contextSnapshot:structuredClone(session.footballReports?.[input.market.slug]?.report)}:{})}:{}),
    ...(analysis?{analysis:structuredClone(analysis)}:{}),
  };
  record(session, now, input.market.slug, side, 'SIGNAL', action === 'BUY' ? 'ENTRY_PENDING' : 'EXIT_PENDING',
    `${reason} Waiting at least ${delay / 1000}s and for a later fresh book before simulating a fill.`, input,{...(analysis?{analysis}:{}),...(exitAnalysis?{exitAnalysis}:{})});
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
    reason: 'Resolved using an explicit final market settlement value.', cashDelta: proceeds, realizedPnl: pnl, rulesRevision:session.rulesRevision??0,strategy:position.strategy??session.config.strategy });
  record(session, now, position.slug, position.side, 'SETTLE', 'SETTLED', 'Final market settlement applied to remaining paper quantity.', input);
  setCooldown(session, position.slug, now);
  return true;
}

function setCooldown(session: TennisSession, slug: string, now: number, unfilled=false) {
  const duration=unfilled?Math.min(session.config.cooldownMs,10_000):session.config.cooldownMs;
  for (const side of ['YES', 'NO'] as const) {
    session.signals[keyFor(slug, side)] = { phase: 'COOLDOWN', confirmations: 0, cooldownUntil: now + duration,
      lastObservedAt: session.consumedBooks[slug], reason: unfilled?'Brief retry delay after an unfilled entry. A new signal and full checks are still required.':'Resting after a completed trade before looking for another entry.' };
    for(const strategy of ['recovery','momentum'])if(session.autoSignals)session.autoSignals[`${keyFor(slug,side)}:${strategy}`]=structuredClone(session.signals[keyFor(slug,side)]);
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
        market: structuredClone(input.market),strategy:intent.signalConfig?.strategy==='auto'?undefined:intent.signalConfig?.strategy,decisionMode:intent.decisionMode??session.config.strategy,
        exitRules:{targetReturn:(intent.signalConfig??session.config).targetReturn,stopReturn:(intent.signalConfig??session.config).stopReturn,maxHoldMs:(intent.signalConfig??session.config).maxHoldMs,source:'entry'},
        ...(intent.contextSnapshot?{entryContext:structuredClone(intent.contextSnapshot)}:{}) });
      if(intent.analysis?.entry){
        const opened=session.positions.at(-1)!,entry=intent.analysis.entry,cfg=intent.signalConfig??session.config;
        opened.entryAnalysis=structuredClone(intent.analysis);
        opened.exitPlan=createExitPlan({openedAt:now,entryAllInUnitCost:-result.cashDelta/result.filledQty,
          risk:{targetReturn:cfg.targetReturn,stopReturn:cfg.stopReturn,maxHoldMs:cfg.maxHoldMs},
          thesis:{referenceBid:entry.referenceBid,riskPrice:entry.riskPrice,volatilityPerSqrtSecond:entry.volatilityPerSqrtSecond,horizonMs:entry.horizonMs,frictionPerShare:entry.frictionPerShare},
          executionDelayMs:cfg.executionDelayMs,tickSize:input.market.execution!.priceIncrement});
      }
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
    source: intent.source, positionId, reason: intent.reason, execution: result, rulesRevision:session.rulesRevision??0,strategy:intent.signalConfig?.strategy??oldPosition?.strategy??session.config.strategy,
    cashDelta: result.cashDelta, realizedPnl: pnl, quotedPrice: intent.limitPrice, actualPrice: result.averagePrice || undefined,
    executionDelayMs: now - intent.createdAt, signalBookTime: intent.observedAt, executionBookTime: input.receivedAt });
  record(session, now, intent.slug, intent.side, result.apply ? intent.action : 'SKIP', result.apply ? result.status.toUpperCase() : 'FILL_FAILED',
    `${intent.reason} ${result.reason}`, input,intent.analysis?{analysis:intent.analysis}:{});
  if (!result.apply && intent.action === 'BUY') setCooldown(session, intent.slug, now,true);
  // Paper exits are IOC: unfilled quantity stays in the position and is retried on later data.
  if (intent.action === 'SELL' && holding(session)) {
    session.lastReason = `Exit ${result.status}; ${holding(session)!.quantity} contracts remain. Waiting for a later book to retry.`;
  }
}

function processPending(session: TennisSession, inputs: TennisInput[], now: number): boolean {
  const intent = session.pending;
  if (!intent) return false;
  const input = inputs.find(item => item.market.slug === intent.slug);
  if (intent.action === 'BUY' && intent.source !== 'AUTOMATIC') {
    session.pending = null;
    record(session, now, intent.slug, intent.side, 'SKIP', 'RETIRED_ENTRY', 'An earlier user-placed entry was canceled. Only the bot can open a position.');
    return false;
  }
  if(intent.action==='BUY'&&session.config.decisionPolicy==='football-context-v1'&&isFootballMarket(intent.market)){
    const state=session.footballReports?.[intent.slug];
    const boundary=!!intent.contextSnapshot&&!!state?.report&&footballBoundaryChanged(intent.contextSnapshot,state.report);
    if(!intent.contextSnapshot||state?.assessment.status!=='fresh'||boundary){
      session.pending=null;
      resetFootballSetup(session,intent.slug,'The game context changed. Confirming a new setup.');
      record(session,now,intent.slug,intent.side,'SKIP',boundary?'CONTEXT_CHANGED':`CONTEXT_${(state?.assessment.status??'unknown').toUpperCase()}`,
        !intent.contextSnapshot?'Pending entry canceled: its original game-context snapshot is missing. Confirming a new setup.':
          boundary?'Pending entry canceled: score, possession or quarter changed. Confirming a new setup.':`Pending entry canceled: ${state?.assessment.reason??'verified context is unavailable.'}`,input);
      return true;
    }
  }
  if (intent.action === 'BUY' && (session.status === 'stopped' || session.status === 'stopping' || (intent.source === 'AUTOMATIC' && session.status !== 'running'))) {
    session.pending = null;
    record(session, now, intent.slug, intent.side, 'SKIP', 'CANCELLED', 'Pending entry canceled because the experiment is paused or stopped.');
    return false;
  }
  if (now < intent.executeAfter) { session.lastReason = 'Paper execution delay is still running.'; return true; }
  const delay=intent.action==='SELL'?(holding(session)?.exitPlan?.executionDelayMs??session.config.executionDelayMs):session.config.executionDelayMs;
  if (now - intent.createdAt > Math.max(30_000, delay * 3)) {
    session.pending = null;
    if(intent.action==='BUY'&&intent.decisionMode==='auto')setCooldown(session,intent.slug,now,true);
    record(session, now, intent.slug, intent.side, 'SKIP', 'INTENT_EXPIRED', 'The paper order expired before a usable later book arrived.');
    return false;
  }
  if (!input || dataIssue(session, input, now) || input.receivedAt <= intent.observedAt || input.receivedAt < intent.executeAfter || input.receivedAt <= (session.consumedBooks[intent.slug] ?? -1)) {
    session.lastReason = 'Waiting for a new authoritative book after the execution delay; cached quotes cannot fill an order.';
    return true;
  }
  if (session.ledger.some(entry => entry.id === intent.id)) { session.pending = null; return false; }
  if (intent.action === 'BUY') {
    const quantitative=intent.signalConfig?.decisionEngine==='local-move-v1';
    const recheck=quantitative?pendingSignalIssue(session,input,intent,now):null;
    const issue = entryIssue(session, input, intent.side, intent.budget ?? 0, now) ?? recheck ?? (quantitative?null:pendingSignalIssue(session, input, intent, now));
    // Recheck the complete entry and its exit costs on the later book.
    if (issue) {
      session.pending = null;
      session.consumedBooks[intent.slug] = input.receivedAt;
      record(session, now, intent.slug, intent.side, 'SKIP', issue.code, `Pending entry canceled: ${issue.reason}`, input);
      if(intent.decisionMode==='auto')setCooldown(session,intent.slug,now,true);
      return false;
    }
  }
  const position = holding(session);
  if (intent.action === 'SELL' && (!position || position.id !== intent.positionId || position.slug !== intent.slug)) {
    session.pending = null; return false;
  }
  const command: PaperCommand = { commandId: intent.id, marketSlug: intent.slug, positionId: intent.positionId,
    side: intent.side, action: intent.action, source: intent.source, limitPrice: intent.limitPrice,
    createdAt: intent.createdAt, strategyVersion: intent.signalConfig?.decisionEngine??position?.entryAnalysis?.version??session.config.decisionEngine??session.config.version,
    ...(intent.action === 'BUY' ? { budget: intent.budget } : { quantity: position!.quantity }) };
  const result = simulate(session, input, command, now);
  session.consumedBooks[intent.slug] = input.receivedAt;
  session.pending = null;
  applyFill(session, intent, result, input, now);
  return true;
}

function beginObservation(session:TennisSession,duration:number|undefined,now:number) {
  if(duration===undefined)return;
  if(!Number.isFinite(duration)||duration<60_000||duration>21_600_000)return;
  session.testRun={startedAt:now,endsAt:now+duration,watchedMs:0,lastCheckAt:now,startingCash:session.cash,
    startingLedgerCount:session.ledger.length,liveSlugs:[],complete:false};
}

function pendingSignalIssue(session:TennisSession,input:TennisInput,intent:TennisIntent,now:number) {
  if(intent.signalConfig?.decisionEngine==='local-move-v1'){
    const analysis=localAnalysis(session,input,intent.side,now,intent.signalConfig);
    if(!intent.analysis?.entry||!analysis)return {code:'ANALYSIS_MISSING',reason:'The delayed entry has no complete local analysis snapshot.'};
    record(session,now,intent.slug,intent.side,analysis.decision==='enter'?'WAIT':'SKIP','ENTRY_RECHECK',`Later-book recheck: ${analysis.reason}`,input,{analysis});
    if(analysis.decision!=='enter'||!analysis.entry)return {code:analysis.code,reason:analysis.reason};
    // Freeze the original scenario; a later quote may invalidate it, never move it away.
    if(analysis.entry.referenceBid>intent.analysis.entry.referenceBid+EPSILON||analysis.entry.riskPrice<intent.analysis.entry.riskPrice-EPSILON)
      return {code:'THESIS_CHANGED',reason:'The delayed entry now needs a higher reference or lower invalidation price. A new setup is required.'};
    intent.analysis=structuredClone(analysis);
    return null;
  }
  const signal=intent.signalSnapshot??session.signals[keyFor(intent.slug,intent.side)],quote=quotes(input,intent.side);
  const config=intent.signalConfig??session.config;
  const price=quote.bid!==undefined&&quote.ask!==undefined?(quote.bid+quote.ask)/2:NaN;
  if(!signal||signal.lastPrice===undefined||signal.lastBid===undefined||signal.baseline===undefined||
    price<signal.lastPrice-EPSILON||quote.bid!<signal.lastBid-EPSILON)
    return {code:'SIGNAL_CHANGED',reason:'The confirmed price or buyers weakened during the execution delay.'};
  if(config.strategy==='recovery') {
    if(signal.dipAt===undefined||now-signal.dipAt>config.baselineWindowMs||price>=signal.baseline||
      signal.trough===undefined||signal.troughBid===undefined||price-signal.trough<config.recoveryPoints/100-EPSILON||
      quote.bid!-signal.troughBid<config.recoveryPoints/100-EPSILON)
      return {code:'SIGNAL_CHANGED',reason:'The recovery expired or no longer meets your entry rules.'};
    const issue=recoveryHeadroomIssue(session,input,intent.side,signal.baseline,now);
    if(issue)return {code:'COST_HEADROOM',reason:issue};
  } else if(signal.dipAt===undefined||now-signal.dipAt>config.baselineWindowMs||price-signal.baseline<config.momentumPoints/100-EPSILON||signal.baselineBid===undefined||
    quote.bid!-signal.baselineBid<config.momentumPoints/100-EPSILON) {
    return {code:'SIGNAL_CHANGED',reason:'The rise is no longer confirmed by current buyers.'};
  } else {
    const buy=simulate(session,input,{...freshCommand(session,input,intent.side,'BUY',now,quote.ask!),budget:intent.budget},now);
    if(!buy.apply||buy.filledQty/-buy.cashDelta-1<session.config.targetReturn-EPSILON)return {code:'COST_HEADROOM',reason:'The maximum payout no longer covers the profit target after entry costs.'};
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
  if (state.cooldownUntil && now < state.cooldownUntil) { state.phase = 'COOLDOWN'; return wait('COOLDOWN', `Entry cooldown: ${Math.ceil((state.cooldownUntil-now)/1000)}s before checking this match for another entry. The bot resumes automatically.`); }
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

type AutoCandidate={intent:TennisIntent;signal:TennisSignal;input:TennisInput;cost:number};
type LocalCandidate={input:TennisInput;side:TradeSide;analysis:OpportunityAnalysis};

function appendLocalHistory(session:TennisSession,input:TennisInput,side:TradeSide){
  const key=keyFor(input.market.slug,side),quote=quotes(input,side),old=session.histories[key]??[];
  if(quote.bid===undefined||quote.ask===undefined||quote.bid>quote.ask||input.receivedAt<=(old.at(-1)?.time??-1))return;
  session.histories[key]=[...old.filter(p=>p.time>=input.receivedAt-session.config.baselineWindowMs),
    {time:input.receivedAt,price:exact((quote.bid+quote.ask)/2),bid:quote.bid,ask:quote.ask,score:input.market.score,period:input.market.period,scoreUpdatedAt:input.market.contextUpdatedAt}].slice(-600);
}

function localAnalysis(session:TennisSession,input:TennisInput,side:TradeSide,now:number,config=session.config):OpportunityAnalysis|null{
  if(!input.market.execution)return null;
  return analyzeOpportunity({history:session.histories[keyFor(input.market.slug,side)]??[],book:input.book,market:input.market.execution,
    side,now,bookReceivedAt:input.receivedAt,bookSource:input.source,budget:config.entryBudget,cash:session.cash,
    executionDelayMs:config.executionDelayMs,maxBookAgeMs:config.maxBookAgeMs,maxSpreadPoints:config.maxSpreadPoints,
    maxHoldMs:config.maxHoldMs,minimumHistoryMs:config.minimumHistoryMs,minSamples:config.minSamples,baselineWindowMs:config.baselineWindowMs,stopReturn:config.stopReturn});
}

function evaluateLocalSide(session:TennisSession,input:TennisInput,side:TradeSide,now:number):LocalCandidate|null{
  const key=keyFor(input.market.slug,side),previous=session.signals[key];
  if(input.receivedAt<=(previous?.lastObservedAt??-1))return null;
  let analysis=localAnalysis(session,input,side,now);
  if(!analysis){record(session,now,input.market.slug,side,'SKIP','ANALYSIS_MAPPING','Verified execution rules are required for local move analysis.',input);return null;}
  const issue=entryIssue(session,input,side,session.config.entryBudget,now);
  const cooldown=previous?.cooldownUntil&&now<previous.cooldownUntil;
  if(issue||cooldown){
    const code=issue?.code??'COOLDOWN',reason=issue?.reason??`Entry cooldown: ${Math.ceil((previous!.cooldownUntil!-now)/1000)}s; current move measurements are still recorded.`;
    analysis={...analysis,decision:issue?'reject':'wait',code,reason,entry:undefined,reasons:[{code,reason,decision:issue?'reject':'wait'},...analysis.reasons]};
  }
  session.signals[key]={phase:cooldown?'COOLDOWN':analysis.code==='HISTORY_WARMUP'?'WARMING':analysis.decision==='enter'?'RECOVERING':'WATCHING',
    confirmations:0,lastObservedAt:input.receivedAt,lastBid:analysis.metrics.bid??undefined,lastPrice:analysis.metrics.currentMid??undefined,
    cooldownUntil:previous?.cooldownUntil,reason:analysis.reason,analysis};
  session.evaluated++;
  record(session,now,input.market.slug,side,analysis.decision==='reject'?'SKIP':'WAIT',analysis.code,analysis.reason,input,{analysis,price:analysis.metrics.currentMid??undefined});
  return analysis.decision==='enter'&&analysis.entry?{input,side,analysis}:null;
}
function resetFootballSetup(session:TennisSession,slug:string,reason:string){
  for(const side of ['YES','NO'] as const){
    const key=keyFor(slug,side),old=session.signals[key];
    if(session.config.decisionEngine==='local-move-v1'&&!holding(session))delete session.histories[key];
    session.signals[key]={phase:'WATCHING',confirmations:0,cooldownUntil:old?.cooldownUntil,reason};
    for(const strategy of ['recovery','momentum'])if(session.autoSignals){
      const track=`${key}:${strategy}`;
      session.autoSignals[track]={phase:'WATCHING',confirmations:0,cooldownUntil:session.autoSignals[track]?.cooldownUntil,reason};
    }
  }
}
function evaluateAutoSide(session:TennisSession,input:TennisInput,side:TradeSide,now:number):AutoCandidate[]{
  const key=keyFor(input.market.slug,side),quote=quotes(input,side),history=session.histories[key]??[];
  const candidates:AutoCandidate[]=[];
  session.autoSignals??={};
  const bookIssue=quoteAvailabilityIssue(quote.bid,quote.ask,input.market.league==='NFL'||input.market.league==='CFB'?'team':'player');
  if(bookIssue){
    for(const strategy of ['recovery','momentum'] as const){
      const track=`${key}:${strategy}`;
      session.autoSignals[track]={phase:'WARMING',confirmations:0,lastObservedAt:input.receivedAt,cooldownUntil:session.autoSignals[track]?.cooldownUntil,reason:bookIssue};
    }
    session.signals[key]={...session.autoSignals[`${key}:recovery`]};
    record(session,now,input.market.slug,side,'SKIP','BOOK',bookIssue,input);
    return candidates;
  }
  if(quote.bid===undefined||quote.ask===undefined)return candidates;
  for(const strategy of ['recovery','momentum'] as const){
    const track=`${key}:${strategy}`,previous=session.autoSignals[track];
    if(previous?.lastObservedAt!==undefined&&input.receivedAt<=previous.lastObservedAt)continue;
    const frozen=previous&&['DIP','RECOVERING','RISING'].includes(previous.phase)&&previous.dipAt!==undefined&&input.receivedAt-previous.dipAt<=session.config.baselineWindowMs;
    const rules=frozen&&previous.autoRules?previous.autoRules:adaptiveTennisRules(history,quote.bid,quote.ask,input.market.execution!.priceIncrement,input.receivedAt);
    if(!rules){record(session,now,input.market.slug,side,'SKIP','AUTO_NOISE','Recent quote movement is outside the supported automatic range.',input,{strategy});continue;}
    // Only updateSignal runs in this sandbox. It cannot debit cash or apply fills.
    // Mutable signal/history/journal containers are isolated from the real account.
    const sandbox:TennisSession={...session,config:{...session.config,declinePoints:rules.declinePoints,recoveryPoints:rules.recoveryPoints,momentumPoints:rules.momentumPoints,strategy},
      signals:{...session.signals,[key]:previous??{phase:'WARMING',confirmations:0,reason:'Building history for both entry patterns.'}},
      histories:{...session.histories,[key]:history},pending:null,decisions:[],rejectionCounts:{},decisionSequence:0,evaluated:0};
    updateSignal(sandbox,input,side,now);
    const signal=sandbox.signals[key];signal.autoRules=rules;
    const last=sandbox.decisions.at(-1);
    signal.reason=`${strategy==='recovery'?'Recovery':'Rise'}: ${last?.reason??signal.reason}`;
    session.autoSignals[track]=signal;
    if(last)record(session,now,input.market.slug,side,last.action==='SIGNAL'?'WAIT':last.action,last.action==='SIGNAL'?'AUTO_READY':last.code,
      `${strategy==='recovery'?'Recovery':'Rise'}: ${last.reason}`,input,{baseline:last.baseline,price:last.price,strategy,autoRules:rules});
    if(sandbox.pending){
      const buy=simulate(session,input,{...freshCommand(session,input,side,'BUY',now,quote.ask),budget:session.config.entryBudget},now);
      const sell=executePaperCommand({...freshCommand(session,input,side,'SELL',now,quote.bid),quantity:buy.filledQty},
        {cash:exact(session.cash+buy.cashDelta),marketExposure:-buy.cashDelta,totalExposure:-buy.cashDelta,availableQuantity:buy.filledQty},input.market.execution!,input.book,policy(session,input,now));
      const intent={...sandbox.pending,decisionMode:'auto' as const,signalSnapshot:structuredClone(signal),reason:`Auto selected ${strategy==='recovery'?'a recovery':'a sustained rise'}. ${sandbox.pending.reason}`};
      candidates.push({intent,signal,input,cost:1-sell.cashDelta/-buy.cashDelta});
    }
  }
  // Advance shared observations once even if one pattern is waiting or too noisy.
  if(input.receivedAt>(history.at(-1)?.time??-1)){
    session.histories[key]=[...history.filter(p=>p.time>=input.receivedAt-session.config.baselineWindowMs&&p.time<input.receivedAt),
      {time:input.receivedAt,price:exact((quote.bid+quote.ask)/2),bid:quote.bid,ask:quote.ask,score:input.market.score,period:input.market.period,scoreUpdatedAt:input.market.contextUpdatedAt}].slice(-600);
    session.evaluated++;
  }
  const signals=['recovery','momentum'].map(strategy=>session.autoSignals![`${key}:${strategy}`]).filter(Boolean);
  const priority=(s:TennisSignal)=>['RECOVERING','RISING'].includes(s.phase)?3:s.phase==='DIP'?2:s.phase==='COOLDOWN'?1:0;
  if(signals.length)session.signals[key]=[...signals].sort((a,b)=>priority(b)-priority(a))[0];
  return candidates;
}

/** Pure reducer. Callers persist the complete returned state with one account revision/CAS. */
export function stepTennisSession(previous: TennisSession, inputs: TennisInput[], now: number): TennisSession {
  if (!Number.isFinite(now) || now < previous.lastTickAt) return previous;
  const session = normalizePositionExitRules(structuredClone(previous));
  session.config = normalizeTennisConfig(session.config);
  session.revision++;
  session.lastTickAt = now;
  const configIssue = validateTennisConfig(session.config);
  if (configIssue) { session.status = 'paused'; session.pending = null; session.lastReason = configIssue; return session; }
  const sorted = inputs.filter(input => input && input.market && input.book).sort((a, b) => b.receivedAt - a.receivedAt);
  const current = [...new Map(sorted.map(input => [input.market.slug, input] as const).reverse()).values()];
  session.footballReports??={};
  for(const input of current){
    if(!isFootballMarket(input.market)||input.source==='REPLAY')continue;
    const prior=session.footballReports[input.market.slug],next=assessFootballContext(input.market,now,prior);
    session.footballReports[input.market.slug]=next;
    if(session.config.decisionPolicy==='football-context-v1'&&prior?.report&&next.report&&footballBoundaryChanged(prior.report,next.report))
      resetFootballSetup(session,input.market.slug,'Score, possession or quarter changed. Confirming a new setup.');
  }
  // A missing market update cannot preserve yesterday's fresh assessment.
  for(const [slug,state] of Object.entries(session.footballReports))if(!current.some(input=>input.market.slug===slug&&input.source!=='REPLAY')&&state.report){
    state.assessment={...state.assessment,reportAgeMs:now-state.report.reportTime,receiptAgeMs:now-state.report.receiptTime};
    if(state.assessment.status==='fresh'&&(now-state.report.reportTime>45000||now-state.report.receiptTime>45000))
      state.assessment={...state.assessment,status:'stale',reason:'The football report is older than 45 seconds. Waiting for fresh context.'};
  }
  session.coverage ??= {};
  session.quotes ??= {};
  session.bookSourceTimes ??= {};
  for (const input of current) {
    const orderingIssue=bookOrderIssue(input,session.bookSourceTimes[input.market.slug],now);
    if(orderingIssue){record(session,now,input.market.slug,'YES','SKIP','BOOK_ORDER',orderingIssue,input);continue;}
    if(dataIssue(session,input,now))continue;
    if(input.sourceTime!==undefined&&input.sourceTime!==null)session.bookSourceTimes[input.market.slug]=input.sourceTime;
    session.coverage[input.market.slug] = {league: input.market.league, time: input.receivedAt, live: freshLive(input,now)};
    session.quotes[input.market.slug] = {time:input.receivedAt,bid:input.book.bids[0]?.price??null,ask:input.book.asks[0]?.price??null,source:input.source,sourceTime:input.sourceTime};
    const held=holding(session);
    const localActive=session.config.decisionEngine==='local-move-v1'&&(session.status==='running'||!!session.pending);
    if((localActive&&(!session.config.focusSlug||session.config.focusSlug===input.market.slug)||held?.exitPlan&&held.slug===input.market.slug)&&now-input.receivedAt<=Math.min(5000,session.config.maxBookAgeMs)){
      for(const side of ['YES','NO'] as const)appendLocalHistory(session,input,side);
    }
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
  for(const input of current)advanceShadowExits(session,input,now,!dataIssue(session,input,now),policy(session,input,now));
  if (open) settle(session, open, current.find(input => input.market.slug === open.slug), now);
  const processed = processPending(session, current, now);
  const position = holding(session);
  if (position) {
    const input = current.find(item => item.market.slug === position.slug);
    if(input)position.lastContext=currentTennisContext(position.lastContext??position.market,input.market,now,position.market.active);
    markPosition(session, position, input, now);
    const realised = session.positions.reduce((sum, item) => sum + item.realizedPnl, 0);
    const completeMark = position.netLiquidationValue !== null && position.liquidationQuantity >= position.quantity - EPSILON;
    const breached = realised <= -session.config.startingCash * session.config.maxSessionLossFraction || (completeMark && tennisEquity(session) <= session.config.startingCash * (1 - session.config.maxSessionLossFraction));
    if (breached) { session.status = 'stopping'; if (session.pending?.action === 'BUY') session.pending = null; }
    if (!session.pending && input && !dataIssue(session, input, now) && input.receivedAt > (session.consumedBooks[position.slug] ?? -1)) {
      const availableReturn = position.netLiquidationValue !== null && position.liquidationQuantity > 0
        ? position.netLiquidationValue / (position.costBasis * position.liquidationQuantity / position.quantity) - 1 : null;
      if(position.exitPlan){
        const quote=quotes(input,position.side),band=Math.max(position.exitPlan.tickSize*2,(quote.ask??0)-(quote.bid??0));
        const bids=quote.bids.filter(q=>q.price>=(quote.bid??0)-band-EPSILON).reduce((n,q)=>n+q.quantity,0);
        const asks=quote.asks.filter(q=>q.price<=(quote.ask??0)+band+EPSILON).reduce((n,q)=>n+q.quantity,0);
        const movement=measureExitMarket((session.histories[keyFor(position.slug,position.side)]??[]).filter(p=>p.time>=position.openedAt),now,Math.max(30000,position.exitPlan.thesis.horizonMs));
        const forcedReason=session.exitRequested?.positionId===position.id?session.exitRequested.reason:session.status==='stopping'?'Session stopped: attempting to close remaining paper quantity.':
          availableReturn!==null&&availableReturn<=-position.exitRules!.stopReturn+EPSILON?'Net loss threshold reached; attempting a price-bounded exit.':
          now-position.openedAt>=position.exitRules!.maxHoldMs?'Maximum holding time reached.':undefined;
        const assessment=assessAdaptiveExit({plan:position.exitPlan,priorState:position.exitState,now,maxBookAgeMs:Math.min(5000,session.config.maxBookAgeMs),
          mark:{bookTime:position.markedAt,netLiquidationValue:position.netLiquidationValue,liquidationQuantity:position.liquidationQuantity,remainingQuantity:position.quantity,remainingCostBasis:position.costBasis},
          market:{bid:quote.bid??NaN,ask:quote.ask??NaN,volatilityPerSqrtSecond:movement?.volatilityPerSqrtSecond??NaN,recoveryDriftLowerPerSecond:movement?.recoveryDriftLowerPerSecond??null,
            imbalance:bids+asks>0?(bids-asks)/(bids+asks):NaN,feeCoefficient:input.market.execution!.feeCoefficient},forcedReason});
        assessment.marketMeasurement=movement;
        position.exitState=assessment.state;
        if(forcedReason||assessment.action==='exit')stage(session,input,position.side,'SELL',now,session.exitRequested?.source??'AUTOMATIC',forcedReason??assessment.reason,undefined,undefined,undefined,assessment);
        else if(!processed)record(session,now,position.slug,position.side,'WAIT',assessment.code,assessment.reason,input,{netReturn:availableReturn??undefined,exitAnalysis:assessment});
      }else{
      // A profit target requires buyers for the entire position. Partial books can still reduce losses.
      const reason = session.exitRequested?.positionId === position.id ? session.exitRequested.reason : session.status === 'stopping' ? 'Session stopped: attempting to close remaining paper quantity.'
        : completeMark && availableReturn !== null && availableReturn >= position.exitRules!.targetReturn - EPSILON ? 'Net profit target reached after estimated exit fees.'
          : availableReturn !== null && availableReturn <= -position.exitRules!.stopReturn + EPSILON ? 'Net loss threshold reached; attempting a price-bounded exit.'
            : now - position.openedAt >= position.exitRules!.maxHoldMs ? 'Maximum holding time reached.' : null;
      if (reason) stage(session, input, position.side, 'SELL', now, session.exitRequested?.source ?? 'AUTOMATIC', reason);
      else if (!processed) record(session, now, position.slug, position.side, 'WAIT', availableReturn === null ? 'NO_EXIT_DEPTH' : 'HOLDING',
        availableReturn === null ? 'No executable exit price is currently available. The position remains open.' : 'Holding until net profit, loss, or time exit rules trigger.', input, { netReturn: availableReturn ?? undefined });
      }
    }
  } else {
    const realised = session.positions.reduce((sum, item) => sum + item.realizedPnl, 0);
    if (realised <= -session.config.startingCash * session.config.maxSessionLossFraction) session.status = 'stopped';
    if (session.status === 'stopping') session.status = 'stopped';
  }
  if (session.status === 'running' && !holding(session) && !session.pending && !processed) {
    const candidates:AutoCandidate[]=[];
    const localCandidates:LocalCandidate[]=[];
    const beforeSequence=session.decisionSequence??0;
    let autoChecked=0;
    for (const input of current.sort((a, b) => a.market.slug.localeCompare(b.market.slug))) {
      if(session.config.focusSlug && session.config.focusSlug!==input.market.slug) continue;
      if(session.config.decisionEngine==='local-move-v1'){
        for(const side of ['YES','NO'] as const){const candidate=evaluateLocalSide(session,input,side,now);if(candidate)localCandidates.push(candidate);autoChecked++;}
        continue;
      }
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
        if(session.config.strategy==='auto'){candidates.push(...evaluateAutoSide(session,input,side,now));autoChecked+=2;}
        else updateSignal(session, input, side, now);
        if (session.pending) break;
      }
      if (session.pending) break;
    }
    if(session.config.decisionEngine==='local-move-v1'){
      localCandidates.sort((a,b)=>(b.analysis.metrics.netRewardRiskRatio??0)-(a.analysis.metrics.netRewardRiskRatio??0)||
        (b.analysis.entry?.netHeadroom??0)-(a.analysis.entry?.netHeadroom??0)||a.input.market.slug.localeCompare(b.input.market.slug)||a.side.localeCompare(b.side));
      const chosen=localCandidates[0];
      if(chosen)stage(session,chosen.input,chosen.side,'BUY',now,'AUTOMATIC',chosen.analysis.reason,session.config.entryBudget,undefined,chosen.analysis);
      if((session.decisionSequence??0)>beforeSequence){
        if(!chosen){
          const recent=session.decisions.filter(d=>Number(d.id.split(':').at(-1))>beforeSequence);
          const best=recent.find(d=>d.analysis?.decision==='wait'&&d.analysis.metrics.recoveryDriftLowerPerSecond!==null&&d.analysis.metrics.recoveryDriftLowerPerSecond!>0)??recent[0];
          if(best)session.lastReason=best.reason;
        }
        session.autoStatus={time:now,checked:autoChecked,qualified:localCandidates.length,reason:session.lastReason};
      }
    }else if(session.config.strategy==='auto'){
      candidates.sort((a,b)=>a.intent.createdAt-b.intent.createdAt||a.cost-b.cost||a.intent.slug.localeCompare(b.intent.slug)||a.intent.side.localeCompare(b.intent.side)||a.intent.signalConfig!.strategy.localeCompare(b.intent.signalConfig!.strategy));
      const chosen=candidates[0];
      if(chosen){
        session.pending=chosen.intent;session.signals[keyFor(chosen.intent.slug,chosen.intent.side)]=chosen.signal;
        record(session,now,chosen.intent.slug,chosen.intent.side,'SIGNAL','ENTRY_PENDING',`${chosen.intent.reason} Checking a later fresh book before entry.`,chosen.input,{strategy:chosen.intent.signalConfig!.strategy as 'recovery'|'momentum',autoRules:chosen.signal.autoRules});
      }else{
        const latest=session.decisions.filter(d=>Number(d.id.split(':').at(-1))>beforeSequence);
        const blocker=[...latest].reverse().find(d=>d.action==='SKIP');
        const progress=[...latest].reverse().find(d=>['DIP','CONFIRMATION','WARMUP'].includes(d.code));
        const cooldown=[...latest].reverse().find(d=>d.code==='COOLDOWN');
        // A repeated book is not a new strategy check. Keep its last result and timestamp.
        if(latest.length)session.lastReason=blocker?.reason??progress?.reason??cooldown?.reason??'Auto is watching for a recovery or a sustained rise. Neither setup is ready yet.';
      }
      if((session.decisionSequence??0)>beforeSequence)session.autoStatus={time:now,checked:autoChecked,qualified:candidates.length,reason:session.lastReason,...(chosen?{selected:chosen.intent.signalConfig!.strategy as 'recovery'|'momentum'}:{})};
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
  let session = normalizePositionExitRules(structuredClone(previous));
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
    const keepCooldowns=(signals:Record<string,TennisSignal>)=>Object.fromEntries(Object.entries(signals).filter(([,signal])=>(signal.cooldownUntil??0)>now).map(([key,signal])=>[key,{phase:'COOLDOWN' as const,confirmations:0,cooldownUntil:signal.cooldownUntil,reason:'Resting after the previous attempt; rule changes keep this rest period.'}]));
    session.histories = {}; session.signals = keepCooldowns(session.signals); session.autoSignals=keepCooldowns(session.autoSignals??{});session.autoStatus=undefined;
    record(session, now, '', 'YES', 'WAIT', 'RULES_UPDATED', `Bot rules saved (revision ${session.rulesRevision}). Gathering a new baseline; balance and history preserved.`);
    return session;
  }
  if (action.action === 'reset') {
    if (holding(session) || session.pending) return reject('Close the paper position and let pending orders finish before resetting.');
    if (!Number.isFinite(action.bankroll) || action.bankroll < 5 || action.bankroll > 1000) return reject('Choose a fake starting balance between $5 and $1,000.');
    session = createTennisSession({...(session.config.decisionEngine?defaultLiveTennisConfig(action.bankroll):defaultTennisConfig(action.bankroll)),strategy:'auto',leagues:session.config.leagues,focusSlug:session.config.focusSlug}, now);
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
